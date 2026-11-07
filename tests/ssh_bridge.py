#!/usr/bin/env python3
"""Offline bridge tests: real PTYs, fake host SSH, no Docker/model requests."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import sys
import tempfile
import time
import termios
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', ROOT / 'bin/cx-ssh-bridge.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.cx-test-ssh-', dir=ROOT)
        self.home = Path(self.temp.name)
        fake = self.home / 'ssh'
        fake.write_text('#!/bin/bash\nprintf "AUTH challenge: "\nread -rs answer\nprintf "\\n"\n[[ "$answer" == test-code ]] || exit 1\nexec bash --noprofile --norc -i\n')
        fake.chmod(0o755)
        self.oldpath = os.environ['PATH']
        os.environ['PATH'] = str(self.home) + ':' + self.oldpath
        self.bridge = module.Bridge('delta-alias', str(self.home), ['/bin/true'])
        self.bridge.remote = self.bridge.spawn(['ssh', '-tt', 'delta-alias'])
        # These tests drive the bridge without a real user terminal.
        self.bridge.resize = lambda *args: None
        self.bridge.notice = lambda *args: None
        self.bridge.start_local = lambda: None
        self.receive, self.send = socket.socketpair()
        self.receive.settimeout(.1)
        self.events = b''
        os.write(self.bridge.remote[0], b'test-code\n')
        self.bridge.activate()
        self.pump(lambda: self.bridge.ready)

    def tearDown(self):
        item = self.bridge.remote
        if item:
            os.killpg(item[1].pid, signal.SIGKILL)
            item[1].wait(timeout=3)
            os.close(item[0])
        self.receive.close()
        self.send.close()
        os.environ['PATH'] = self.oldpath
        self.temp.cleanup()

    def pump(self, condition):
        deadline = time.monotonic() + 5
        while not condition():
            self.assertLess(time.monotonic(), deadline, 'PTY response timed out')
            ready, _, _ = select.select([self.bridge.remote[0]], [], [], .1)
            if ready:
                self.bridge.output(os.read(self.bridge.remote[0], 65536))

    def command(self, command):
        self.events = b''
        self.bridge.request(self.send, {'op': 'exec', 'command': command})
        self.pump(lambda: self.bridge.pending is None)
        while True:
            try:
                self.events += self.receive.recv(65536)
            except socket.timeout:
                break
        return [json.loads(line) for line in self.events.splitlines()]

    def test_state_output_and_status(self):
        import base64
        self.assertEqual(self.command("export CX_TEST='hello world'; cd /")[-1]['status'], 0)
        events = self.command('printf "%s:%s" "$CX_TEST" "$PWD"; false')
        output = b''.join(base64.b64decode(e['data']) for e in events if e['type'] == 'output')
        self.assertIn(b'hello world:/', output)
        self.assertEqual(events[-1]['status'], 1)

    def test_quoting_and_marker_like_output(self):
        events = self.command("printf '%s\\n' \"single ' double \\\"\"; printf '\\036not-a-marker:0\\037';\ntrue")
        self.assertEqual(events[-1]['status'], 0)

    def test_busy_and_disconnect(self):
        self.bridge.begin('sleep 10', self.send)
        self.bridge.request(self.send, {'op': 'exec', 'command': 'echo must-not-run'})
        event = json.loads(self.receive.recv(4096))
        self.assertEqual(event['status'], 125)
        self.bridge.finish(255, 'SSH disconnected; command outcome unknown')
        event = json.loads(self.receive.recv(4096))
        self.assertEqual(event['status'], 255)

    def test_manual_auth_input_not_in_result(self):
        self.bridge.focus = 'remote'
        self.bridge.begin("read -rs -p 'MFA: ' code; unset code", self.send)
        os.write(self.bridge.remote[0], b'another-secret\n')
        self.pump(lambda: self.bridge.pending is None)
        event = json.loads(self.receive.recv(4096))
        self.assertEqual(event['type'], 'done')
        self.assertNotIn('another-secret', json.dumps(event))

    def test_fragmented_marker(self):
        import base64
        self.bridge.pending = {'client': self.send, 'token': b'fixed'}
        for data in (b'no newline', b'\x1e', b'fix', b'ed:', b'7', b'\x1f'):
            self.bridge.output(data)
        data = self.receive.recv(4096)
        events = [json.loads(line) for line in data.splitlines()]
        self.assertEqual(base64.b64decode(events[0]['data']), b'no newline')
        self.assertEqual(events[-1]['status'], 7)


    def test_supervisor_terminal_handoff(self):
        launcher = self.home / 'local.py'
        launcher.write_text("""import os, socket, json
print('LOCAL-READY', flush=True)
input()
s = socket.socket(socket.AF_UNIX)
s.connect(os.environ['CX_SSH_BRIDGE_DIR'] + '/bridge.sock')
s.sendall(b'{"op":"exec","command":"printf supervisor-ok"}\\n')
data = b''
while b'"done"' not in data:
    data += s.recv(65536)
print(data.decode(), flush=True)
""")
        driver = module.Bridge('unused', '', [])
        master, process = driver.spawn([sys.executable, str(ROOT / 'bin/cx-ssh-bridge.py'),
                                        'delta-alias', '', sys.executable, str(launcher)])
        original_terminal = termios.tcgetattr(master)
        output = b''
        def until(text):
            nonlocal output
            deadline = time.monotonic() + 5
            while text not in output:
                self.assertLess(time.monotonic(), deadline, output.decode(errors='replace'))
                ready, _, _ = select.select([master], [], [], .1)
                if ready:
                    output += os.read(master, 65536)
        try:
            until(b'AUTH challenge:')
            os.write(master, b'test-code\r')
            until(b'bash-')
            os.write(master, b'\x1dc')
            until(b'LOCAL-READY')
            os.write(master, b'\x1dr')
            until(b'Remote terminal.')
            os.write(master, b'export MANUAL_STATE=retained\r')
            os.kill(process.pid, signal.SIGWINCH)
            os.write(master, b'\x1dc\r')
            until(b'"done"')
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertEqual(termios.tcgetattr(master), original_terminal)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)



class MountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.cx-test-mount-', dir=ROOT)
        self.bridge = module.Bridge('delta-alias', '/remote/project with spaces',
                                    [str(ROOT / 'bin/cx'), '/local/project'])
        self.bridge.root = self.temp.name
        self.bridge.runtime = self.temp.name + '/bridge'
        self.bridge.control_path = self.temp.name + '/control'
        self.bridge.mount_mode = 'ro'
        self.bridge.notice = Mock()
        self.bridge.resize = Mock()

    def tearDown(self):
        if self.bridge.mount_log:
            self.bridge.mount_log.close()
        self.temp.cleanup()

    def test_mount_options_and_connection_reuse(self):
        for mode in ('ro', 'rw'):
            with self.subTest(mode=mode):
                self.bridge.mount_mode = mode
                self.bridge.mount_path = None
                with patch.object(self.bridge, 'is_mounted', return_value=True), patch.object(module.subprocess, 'Popen') as launch:
                    launch.return_value.poll.return_value = None
                    self.bridge.mount_files()
                    args = launch.call_args.args[0]
                    self.assertIn('delta-alias:/remote/project with spaces', args)
                    self.assertIn('ControlPath=' + self.bridge.control_path, args)
                    self.assertIn('BatchMode=yes', args)
                    self.assertIn('RemoteCommand=none', args)
                    self.assertIn(mode, args)
                    self.assertIn('allow_other,default_permissions,idmap=user', args)
                    self.assertEqual(self.bridge.mount_path, self.temp.name + '/files')
                    self.bridge.mount_log.close()
                    self.bridge.mount_log = None

    def test_shell_creates_shared_connection(self):
        self.bridge.connection_help = Mock()
        self.bridge.spawn = Mock()
        self.bridge.connect()
        args = self.bridge.spawn.call_args.args[0]
        self.assertIn('ControlMaster=auto', args)
        self.assertIn('ControlPath=' + self.bridge.control_path, args)
        self.assertEqual(args[-1], 'delta-alias')

    def test_mount_failure_does_not_launch_codex(self):
        self.bridge.spawn = Mock()
        with patch.object(module.subprocess, 'Popen') as launch:
            launch.return_value.poll.return_value = 1
            with self.assertRaisesRegex(OSError, 'SSHFS mount failed'):
                self.bridge.start_local()
        self.bridge.spawn.assert_not_called()

    def test_cleanup_and_unmount_failure(self):
        with patch.object(self.bridge, 'is_mounted', return_value=True), patch.object(module.shutil, 'which', return_value='/usr/bin/fusermount3'), patch.object(module.subprocess, 'run') as unmount:
            unmount.return_value.returncode = 0
            self.assertTrue(self.bridge.cleanup_mount())
            self.assertEqual(unmount.call_args.args[0], ['/usr/bin/fusermount3', '-u', self.temp.name + '/files'])
            unmount.return_value.returncode = 1
            self.assertFalse(self.bridge.cleanup_mount())
            self.assertEqual(unmount.call_args.args[0][1], '-uz')
            self.assertIn('retaining', self.bridge.notice.call_args.args[0])

    def test_mounted_session_instructions_and_environment(self):
        self.bridge.mount_path = self.temp.name + '/files'
        self.bridge.spawn = Mock(return_value=(1, Mock()))
        with patch.object(self.bridge, 'mount_files'):
            self.bridge.start_local()
        args, env = self.bridge.spawn.call_args.args
        instructions = json.loads(args[3].split('=', 1)[1])
        self.assertIn('/workspace/remote', instructions)
        self.assertIn('read-only', instructions)
        self.assertIn('/remote/project with spaces', instructions)
        self.assertEqual(env['CX_SSH_MOUNT_PATH'], self.bridge.mount_path)
        self.assertEqual(env['CX_SSH_BRIDGE_DIR'], self.bridge.runtime)
        self.assertNotIn('CX_SSH_CONTROL_PATH', env)


if __name__ == '__main__':
    unittest.main()
