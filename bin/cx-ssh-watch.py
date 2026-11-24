#!/usr/bin/env python3
"""Serve a single bounded watch request over an independent OpenSSH channel."""
import base64
import hashlib
import json
import os
import re
import selectors
import shlex
import signal
import socket
import subprocess
import sys
import time
import uuid

LIMIT = 128 * 1024


def fail(message, retry=False):
    return dict(type='watch', error=message, retry=retry)


def run(client, host, control, seconds, command):
    # Bound execution on the server as well as the client. BatchMode and strict
    # host key checking keep the user's authentication in the interactive SSH.
    token = uuid.uuid4().hex
    wrapper = 'sh -c "$1"; printf "\\036%s:%s\\037" ' + token + ' "$?" >&2'
    remote = f'timeout --kill-after=1s {seconds:.3f}s sh -c ' + shlex.quote(wrapper) + ' sh ' + shlex.quote(command)
    args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'RemoteCommand=none', '-o', 'SessionType=default', '-o', 'ControlMaster=no', '-S', control,
            '-o', 'ConnectTimeout=' + str(max(1, min(15, int(seconds)))), '--', host, remote]
    try:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
    except OSError:
        return fail('Cannot start OpenSSH on the CX host.')
    samples = {proc.stdout: bytearray(), proc.stderr: bytearray()}
    digests = {stream: hashlib.sha256() for stream in samples}
    frame = re.compile(rb'\x1e' + token.encode() + rb':([0-9]{1,3})\x1f')
    err_tail = b''
    deadline = time.monotonic() + seconds

    def collect(stream, chunk):
        digests[stream].update(chunk)
        samples[stream].extend(chunk[:max(0, LIMIT - len(samples[stream]))])

    try:
        with selectors.DefaultSelector() as selector:
            selector.register(client, selectors.EVENT_READ)
            for stream in samples:
                selector.register(stream, selectors.EVENT_READ)
            while len(selector.get_map()) > 1 or proc.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return fail('Remote command timed out.', retry=True)
                for key, _ in selector.select(min(remaining, 0.1)):
                    stream = key.fileobj
                    if stream is client:
                        # The protocol sends one request. EOF or further input
                        # means the watcher is gone or abandoned this command.
                        return None
                    chunk = os.read(stream.fileno(), 65536)
                    if chunk:
                        if stream is proc.stderr:
                            chunk = err_tail + chunk
                            # Keep a tail for the status frame even when the
                            # captured stderr sample has reached its limit.
                            err_tail, chunk = chunk[-4096:], chunk[:-4096]
                        collect(stream, chunk)
                    else:
                        selector.unregister(stream)
        status = proc.wait()
        match = frame.search(err_tail)
        if match:
            collect(proc.stderr, err_tail[:match.start()] + err_tail[match.end():])
        else:
            collect(proc.stderr, err_tail)
        if status == 255:
            detail = samples[proc.stderr].lower()
            if b'permission denied' in detail or b'host key verification failed' in detail:
                return fail('SSH needs interactive login or host-key confirmation. Start cx --ssh ' + host + ' first.')
            if b'could not resolve hostname' in detail or b'bad configuration option' in detail:
                return fail('OpenSSH could not resolve or load the configured host alias.')
            return fail('SSH connection dropped or could not be established.', retry=True)
        if status in (124, 137):
            return fail('Remote command timed out.', retry=True)
        if status == 127 and b'timeout' in samples[proc.stderr]:
            return fail('Remote watches require the server timeout utility.')
        if status or not match:
            return fail('Remote watch could not confirm the command exit status.', retry=True)
        return dict(type='watch', status=int(match[1]),
                    digest=':'.join(digest.hexdigest() for digest in digests.values()),
                    out=base64.b64encode(samples[proc.stdout]).decode(),
                    err=base64.b64encode(samples[proc.stderr]).decode())
    finally:
        # Kill the process group even if the transport leader exited, since a
        # ProxyCommand descendant can still hold its pipes open.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        for stream in samples:
            stream.close()


def main():
    host, control, seconds, command = sys.argv[1:]

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    with socket.socket(fileno=0) as client:
        response = run(client, host, control, float(seconds), command)
        if response is not None:
            client.settimeout(1)
            try:
                client.sendall((json.dumps(response) + '\n').encode())
            except OSError:
                pass


if __name__ == '__main__':
    main()
