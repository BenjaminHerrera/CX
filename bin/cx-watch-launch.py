#!/usr/bin/env python3
"""Run an assistant container with a private host OpenSSH watch service."""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading

spec = importlib.util.spec_from_file_location('cx_ssh_watch', Path(__file__).with_name('cx-ssh-watch.py'))
ssh_watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ssh_watch)


class WatchServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, WatchHandler)
        self.capacity = threading.BoundedSemaphore(8)
        self.connections = set()
        self.lock = threading.Lock()


class WatchHandler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        server = self.server
        acquired = server.capacity.acquire(blocking=False)
        with server.lock:
            server.connections.add(client)
        try:
            if not acquired:
                response = ssh_watch.fail('SSH watch capacity reached. Retrying.', retry=True)
            else:
                client.settimeout(2)
                data = b''
                while b'\n' not in data and len(data) <= 32768:
                    chunk = client.recv(32768)
                    if not chunk:
                        return
                    data += chunk
                request = json.loads(data)
                if not isinstance(request, dict):
                    raise ValueError('Expected an object.')
                host, command, timeout = (request.get(key) for key in ('host', 'command', 'timeout'))
                if (request.get('op') != 'watch' or not isinstance(host, str) or
                        not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', host) or
                        not isinstance(command, str) or '\0' in command or
                        not 0 < len(command.encode()) <= 16384 or
                        type(timeout) not in (int, float) or not 1000 <= timeout <= 3600000):
                    response = ssh_watch.fail('Invalid SSH watch request.')
                else:
                    control = None
                    if host == os.environ.get('CX_SSH_HOST') and os.environ.get('CX_SSH_BRIDGE_DIR'):
                        control = str(Path(os.environ['CX_SSH_BRIDGE_DIR']).parent / 'control')
                    client.settimeout(None)
                    response = ssh_watch.run(client, host, control, timeout / 1000, command)
            if response is not None:
                client.settimeout(1)
                client.sendall((json.dumps(response) + '\n').encode())
        except (ValueError, TypeError, OSError):
            try:
                client.sendall((json.dumps(ssh_watch.fail('Cannot process the SSH watch request.')) + '\n').encode())
            except OSError:
                pass
        finally:
            with server.lock:
                server.connections.discard(client)
            if acquired:
                server.capacity.release()


def main():
    args = sys.argv[1:]
    if args[:2] != ['docker', 'run']:
        raise SystemExit('cx-watch-launch requires docker run arguments.')
    with tempfile.TemporaryDirectory(prefix='cx-watch-') as directory:
        with WatchServer(directory + '/watch.sock') as server:
            os.chmod(directory + '/watch.sock', 0o600)
            threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True).start()
            mount = ['--mount', f'type=bind,src={directory},dst=/cx-watch-host,readonly',
                     '--env', 'CX_WATCH_SOCKET=/cx-watch-host/watch.sock']
            process = None

            def stop(*_):
                if process is not None:
                    process.terminate()

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            try:
                process = subprocess.Popen(args[:2] + mount + args[2:])
                return process.wait()
            finally:
                server.shutdown()
                with server.lock:
                    for client in server.connections:
                        # EOF tells each worker to kill its independent SSH.
                        try:
                            client.shutdown(2)
                        except OSError:
                            pass


if __name__ == '__main__':
    sys.exit(main())
