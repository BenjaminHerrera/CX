#!/usr/bin/env python3
"""Offline bridge tests: real PTYs, fake host SSH, no Docker/model requests."""
import importlib.util
import json
import os
from pathlib import Path
import re
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

    def test_late_terminal_reply_does_not_corrupt_real_pty_password_read(self):
        local_read, local_write = os.pipe()
        self.bridge.local = (local_write, object())
        actual_write = os.write
        def display_or_deliver(fd, data):
            return len(data) if fd == 1 else actual_write(fd, data)
        try:
            with patch.object(module.os, 'write', side_effect=display_or_deliver):
                self.bridge.terminal.render(self.bridge.local, b'\x1b[6n')
                self.bridge.begin("read -rs answer; [[ $answer == valid-code ]]; result=$?; unset answer; (exit $result)", self.send)
                self.bridge.keyboard(b'\x1dr\x1dr\x1b[8;11Rvalid-code\n')
                self.pump(lambda: self.bridge.pending is None)
            self.assertEqual(os.read(local_read, 100), b'\x1b[1;1R')
            event = json.loads(self.receive.recv(4096))
            self.assertEqual(event['status'], 0)
        finally:
            os.close(local_read)
            os.close(local_write)
            self.bridge.local = None

    def test_command_framing_hides_internal_input_and_restores_tty(self):
        import base64
        def output(events):
            return b''.join(base64.b64decode(e['data']) for e in events if e['type'] == 'output')
        before = output(self.command('stty -g')).strip()
        events = self.command('printf visible-output; false')
        text = output(events)
        self.assertEqual(text, b'visible-output')
        self.assertEqual(events[-1]['status'], 1)
        self.assertEqual(output(self.command('stty -g')).strip(), before)
        self.assertEqual(output(self.command('printf "%s" "${__cx_status:-unset}"')), b'unset')

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
print('REMOTE-EXEC-SUCCESS', flush=True)
input()
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
            os.write(master, b'\x1dr\x1drtest-code\r')
            until(b'bash-')
            os.write(master, b'\x1dc')
            until(b'LOCAL-READY')
            os.write(master, b'\x1dr')
            until(b'Remote terminal.')
            os.write(master, b'export MANUAL_STATE=retained\r')
            os.kill(process.pid, signal.SIGWINCH)
            os.write(master, b'\x1dc\r')
            until(b'REMOTE-EXEC-SUCCESS')
            os.write(master, b'\r')
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


class TerminalRoutingTests(unittest.TestCase):
    def setUp(self):
        self.bridge = module.Bridge('host', '/project', [])
        self.bridge.remote = (101, object())
        self.bridge.local = (102, object())
        self.bridge.ready = False
        self.bridge.notice = Mock()
        self.bridge.resize = Mock()
        self.writes = {}
        def write(fd, data):
            self.writes.setdefault(fd, bytearray()).extend(data)
            return len(data)
        self.output_patch = patch.object(module.os, 'write', side_effect=write)
        self.output_patch.start()
        self.addCleanup(self.output_patch.stop)

    def received(self, owner):
        return bytes(self.writes.get(owner[0], b''))

    def test_repeated_remote_shortcut_does_not_type_into_password_prompt(self):
        self.bridge.keyboard(b'\x1dr\x1drcorrect-password\r')
        self.assertEqual(self.received(self.bridge.remote), b'correct-password\r')

    def test_return_to_codex_does_not_type_into_remote_interactive_prompt(self):
        self.bridge.ready = True
        self.bridge.keyboard(b'\x1dc')
        self.assertEqual(self.bridge.focus, 'local')
        self.assertEqual(self.received(self.bridge.remote), b'')

    def test_fragmented_cursor_query_uses_its_own_virtual_screen(self):
        self.bridge.focus = 'local'
        self.bridge.terminal.render(self.bridge.local, b'\x1b[')
        self.bridge.terminal.render(self.bridge.local, b'6n')
        self.bridge.keyboard(b'\x1drpass')
        for byte in b'\x1b[12;40R':
            self.bridge.keyboard(bytes([byte]))
        self.bridge.keyboard(b'word\r')
        self.assertEqual(self.received(self.bridge.remote), b'password\r')
        self.assertEqual(self.received(self.bridge.local), b'\x1b[1;1R')

    def test_unrequested_reports_focus_and_mouse_do_not_become_input(self):
        reports = (b'\x1b[?1;2c\x1b[>0;276;0c\x1b[?31u\x1b[?1004;2$y'
                   b'\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[I\x1b[O'
                   b'\x1b[<0;12;9M\x1b[M !!\x1b[32;12;9M')
        for byte in b'pass' + reports + b'word\r':
            self.bridge.keyboard(bytes([byte]))
        self.assertEqual(self.received(self.bridge.remote), b'password\r')

    def test_device_and_color_responses_keep_their_owners(self):
        self.bridge.terminal.render(self.bridge.local, b'\x1b[>c')
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[c\x1b]11;?\x07')
        self.bridge.keyboard(b'\x1b[?1;2c\x1b[>0;276;0c\x1b]11;rgb:0/0/0\x07')
        self.assertEqual(self.received(self.bridge.local), b'\x1b[>0;0;0c')
        self.assertEqual(self.received(self.bridge.remote), b'\x1b[?6c\x1b]11;rgb:0000/0000/0000\x1b\\')

    def test_reply_to_old_session_is_not_delivered_to_reused_descriptor(self):
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[6n')
        self.bridge.remote = (101, object())
        self.writes.clear()
        self.bridge.keyboard(b'\x1b[2;3Rhello')
        self.assertEqual(self.received(self.bridge.remote), b'hello')

    def test_keyboard_modes_are_restored_per_terminal_without_stack_growth(self):
        self.bridge.terminal.enabled = True
        self.bridge.terminal.render(self.bridge.local, b'\x1b[?1004h\x1b[?2004h\x1b[>31u\x1b[>4;2m')
        self.bridge.switch_focus('remote')
        self.assertIn(b'\x1b[?1004l', self.writes[1])
        self.assertIn(b'\x1b[=0u', self.writes[1])
        self.writes.clear()
        self.bridge.switch_focus('local')
        self.assertIn(b'\x1b[?1004h', self.writes[1])
        self.assertIn(b'\x1b[=31u', self.writes[1])
        self.assertNotIn(b'\x1b[>31u', self.writes[1])
        self.assertEqual(self.bridge.terminal.state(self.bridge.local)['keys'], [0, 31])

    def test_enhanced_keyboard_handoff_and_late_key_releases(self):
        self.bridge.focus = 'local'
        self.bridge.keyboard(b'\x1b[93;5u\x1b[93;5:3u\x1b[114u')
        self.assertEqual(self.bridge.focus, 'remote')
        self.bridge.keyboard(b'\x1b[114;1:3u\x1b[112u\x1b[97u\x1b[115u\x1b[115u\x1b[13u')
        self.assertEqual(self.received(self.bridge.remote), b'pass\r')

    def test_late_key_releases_do_not_interrupt_a_submitted_prompt(self):
        self.bridge.focus = 'local'
        self.bridge.keyboard(b'Run the tests\r\x1b[99;5:3u\x1b[27;1:3u\x1b[67;46;3;0;8;1_')
        self.assertEqual(self.received(self.bridge.local), b'Run the tests\r')

    def test_bridge_wheel_capture_policy_survives_child_requests_and_switches(self):
        self.bridge.terminal.start()
        modes = self.bridge.terminal.MOUSE_MODES
        request = b'\x1b[?' + b';'.join(str(mode).encode() for mode in modes) + b'h'
        for owner in (self.bridge.remote, self.bridge.local):
            for byte in request:
                self.bridge.terminal.render(owner, bytes([byte]))
        for _ in range(3):
            self.bridge.switch_focus('remote')
            self.bridge.switch_focus('local')
        physical = bytes(self.writes[1])
        for mode in modes:
            self.assertIn(f'\033[?{mode}l'.encode(), physical)
            if mode not in (1000, 1006):
                self.assertNotIn(f'\033[?{mode}h'.encode(), physical)
        for parameters in re.findall(rb'\x1b\[\?([0-9;]+)h', physical):
            self.assertTrue(set(map(int, parameters.split(b';'))).intersection(modes).issubset({1000, 1006}))
        self.bridge.keyboard(b'\x1dm')
        self.assertFalse(self.bridge.terminal.mouse_scroll)
        self.writes.clear()
        self.bridge.switch_focus('remote')
        self.bridge.switch_focus('local')
        for mode in modes:
            self.assertNotIn(f'\033[?{mode}h'.encode(), bytes(self.writes[1]))

    def test_requested_mouse_modes_are_virtualized_per_application(self):
        for owner in (self.bridge.remote, self.bridge.local):
            for mode in self.bridge.terminal.MOUSE_MODES:
                self.bridge.terminal.render(owner, f'\033[?{mode}h\033[?{mode}$p\033[?{mode}l\033[?{mode}$p'.encode())
            expected = b''.join(f'\033[?{mode};1$y\033[?{mode};2$y'.encode()
                                for mode in self.bridge.terminal.MOUSE_MODES)
            self.assertEqual(self.received(owner), expected)

    def test_late_mouse_reports_are_dropped_even_after_capture_requests(self):
        self.bridge.terminal.start()
        for focus, owner in (('remote', self.bridge.remote), ('local', self.bridge.local)):
            self.bridge.focus = focus
            self.bridge.terminal.render(owner, b'\x1b[?1000;1006h')
            reports = b'\x1b[<0;5;1M\x1b[<0;5;2m\x1b[M !!\x1b[32;12;9M'
            for byte in b'pass' + reports + b'word\r':
                self.bridge.keyboard(bytes([byte]))
            self.assertEqual(self.received(owner), b'password\r')

    def test_wheel_scrolls_saved_history_without_typing_into_shell(self):
        self.bridge.terminal.start()
        display = self.bridge.terminal.display
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[2m' + b'line\r\n' * 40)
        for byte in b'\x1b[<64;5;4M':
            self.bridge.keyboard(bytes([byte]))
        self.assertEqual(display.pane(self.bridge.remote).screen.scroll_offset, 3)
        self.assertEqual(self.received(self.bridge.remote), b'')
        self.bridge.terminal.render(self.bridge.local, b'CODEX\r\n' * 40)
        self.bridge.switch_focus('local')
        self.bridge.keyboard(b'\x1b[<64;5;4M')
        self.assertEqual(display.pane(self.bridge.local).screen.scroll_offset, 3)
        self.bridge.keyboard(b'\x1b[<65;5;4M')
        self.assertEqual(display.pane(self.bridge.local).screen.scroll_offset, 0)
        self.assertEqual(display.pane(self.bridge.remote).screen.scroll_offset, 3)
        self.assertEqual(self.received(self.bridge.local), b'')

    def test_only_wheel_reaches_mouse_aware_application_with_adjusted_row(self):
        self.bridge.terminal.start()
        self.bridge.focus = 'local'
        self.bridge.terminal.render(self.bridge.local, b'\x1b[?1000;1006h')
        self.bridge.keyboard(b'\x1b[<64;5;4M\x1b[<65;5;4M\x1b[<80;5;4M'
                             b'\x1b[<0;5;4M\x1b[<0;5;4m\x1b[<32;5;4M')
        self.assertEqual(self.received(self.bridge.local), b'\x1b[<64;5;3M\x1b[<65;5;3M\x1b[<80;5;3M')
        self.assertEqual(self.received(self.bridge.remote), b'')

    def test_wheel_encoding_matches_application_and_late_events_are_ignored(self):
        self.bridge.terminal.start()
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[?1000h')
        self.bridge.keyboard(b'\x1b[<64;5;4M')
        self.assertEqual(self.received(self.bridge.remote), b'\x1b[M' + bytes((96, 37, 35)))
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[?1015h')
        self.bridge.keyboard(b'\x1b[M' + bytes((97, 37, 36)))
        self.assertEqual(self.received(self.bridge.remote), b'\x1b[M' + bytes((96, 37, 35)) + b'\x1b[97;5;3M')
        self.writes.clear()
        self.bridge.keyboard(b'\x1b[<64;5;1M\x1b[<65;81;4M\x1b[<64;5;25M\x1b[<66;5;4M\x1b[<64;5;4m')
        self.bridge.keyboard(b'\x1dm\x1b[<64;5;4M')
        self.assertEqual(self.received(self.bridge.remote), b'')

    def test_live_shortcut_typing_and_paste_leave_history_without_injecting_shortcuts(self):
        self.bridge.terminal.start()
        display = self.bridge.terminal.display
        self.bridge.terminal.render(self.bridge.remote, b'line\r\n' * 40)
        for input_data in (b'\x1db', b'x', b'\x1b[A', b'\x1b[200~paste\x1b[201~'):
            display.scroll(self.bridge.remote, 6)
            self.bridge.keyboard(input_data)
            self.assertEqual(display.pane(self.bridge.remote).screen.scroll_offset, 0)
        self.assertEqual(self.received(self.bridge.remote), b'x\x1b[Apaste')

    def test_theme_probe_responses_are_cached_and_never_become_authentication_input(self):
        self.bridge.terminal.start()
        self.assertIn(b'\x1b]11;?\x1b\\', self.writes[1])
        for byte in b'pass\x1b]11;rgb:abcd/1234/0000\x1b\\word\r':
            self.bridge.keyboard(bytes([byte]))
        self.assertEqual(self.received(self.bridge.remote), b'password\r')
        self.bridge.terminal.render(self.bridge.local, b'\x1b]11;?\x07')
        self.assertEqual(self.received(self.bridge.local), b'\x1b]11;rgb:abcd/1234/0000\x1b\\')
        self.bridge.keyboard(b'\x1b]11;rgb:ffff/ffff/ffff\x07')
        self.assertEqual(self.bridge.terminal.colors['11'], 'abcd/1234/0000')

    def test_cursor_queries_while_scrolled_use_live_application_coordinates(self):
        self.bridge.terminal.start()
        self.bridge.terminal.render(self.bridge.remote, b'line\r\n' * 40 + b'cursor')
        pane = self.bridge.terminal.display.pane(self.bridge.remote)
        expected = f'\033[{pane.screen.cursor.y + 1};{pane.screen.cursor.x + 1}R'.encode()
        self.bridge.terminal.display.scroll(self.bridge.remote, 6)
        self.bridge.terminal.render(self.bridge.remote, b'\x1b[6n')
        self.assertEqual(self.received(self.bridge.remote), expected)
        self.assertEqual(pane.screen.scroll_offset, 6)

    def test_focus_events_and_key_releases_do_not_leave_history(self):
        self.bridge.terminal.start()
        self.bridge.terminal.render(self.bridge.remote, b'line\r\n' * 40 + b'\x1b[?1004h')
        display = self.bridge.terminal.display
        display.scroll(self.bridge.remote, 6)
        self.bridge.keyboard(b'\x1b[I\x1b[O\x1b[99;5:3u')
        self.assertEqual(display.pane(self.bridge.remote).screen.scroll_offset, 6)
        self.assertEqual(self.received(self.bridge.remote), b'\x1b[I\x1b[O')

    def test_quit_shortcut_does_not_type_into_the_remote_session(self):
        self.bridge.keyboard(b'\x1dq')
        self.assertFalse(self.bridge.running)
        self.assertEqual(self.bridge.result, 130)
        self.assertEqual(self.received(self.bridge.remote), b'')

    def test_navigation_and_unicode_input_are_preserved(self):
        data = b'\x1b[A\x1b[B\x1b[1;5C' + 'é🐈'.encode() + b'\r'
        self.bridge.keyboard(data)
        self.assertEqual(self.received(self.bridge.remote), data)

    def test_bracketed_paste_does_not_interpret_shortcuts_or_interrupts(self):
        self.bridge.focus = 'local'
        self.bridge.terminal.state(self.bridge.local)['modes'].add(2004)
        data = b'\x1b[200~literal\x1dr\x1b[9;9R\x03\x1b]unterminated OSC\x1b[201~'
        for byte in data:
            self.bridge.keyboard(bytes([byte]))
        self.assertEqual(self.bridge.focus, 'local')
        self.assertEqual(self.received(self.bridge.local), data)
        self.assertEqual(self.received(self.bridge.remote), b'')
        self.assertFalse(self.bridge.terminal.pasting)

    def test_background_shell_modes_are_used_for_password_handoff(self):
        self.bridge.focus = 'local'
        self.bridge.output(b'\x1b[?2004h')
        self.bridge.output(b'\x1b[?2004l')
        self.assertEqual(self.writes.get(1, b''), b'')
        self.assertNotIn(2004, self.bridge.terminal.state(self.bridge.remote)['modes'])
        self.bridge.keyboard(b'\x1dr\x1b[200~password\x1b[201~\r')
        self.assertEqual(self.received(self.bridge.remote), b'password\r')

    def test_windows_terminal_modes_and_late_key_events(self):
        self.bridge.terminal.enabled = True
        self.bridge.terminal.render(self.bridge.local, b'\x1b[?9001h')
        self.bridge.switch_focus('remote')
        self.assertIn(b'\x1b[?9001l', self.writes[1])
        self.bridge.keyboard(b'\x1b[80;25;112;1;0;1_\x1b[80;25;112;0;0;1_')
        self.bridge.keyboard(b'\x1b[65;30;97;1_\x1b[13;28;13;1_')
        self.assertEqual(self.received(self.bridge.remote), b'pa\r')
        self.writes.clear()
        self.bridge.switch_focus('local')
        self.assertIn(b'\x1b[?9001h', self.writes[1])

    def test_windows_shortcut_and_utf16_pair(self):
        self.bridge.focus = 'local'
        self.bridge.keyboard(b'\x1b[221;27;29;1;8;1_\x1b[82;19;114;1_')
        self.assertEqual(self.bridge.focus, 'remote')
        self.bridge.keyboard(b'\x1b[0;0;55357;1_\x1b[0;0;56328;1_')
        self.assertEqual(self.received(self.bridge.remote), '🐈'.encode())

    def test_standalone_escape_still_reaches_the_application(self):
        self.bridge.keyboard(b'\x1b')
        self.assertEqual(self.received(self.bridge.remote), b'')
        with patch.object(module.time, 'monotonic', return_value=self.bridge.terminal.input_since + .1):
            self.assertEqual(self.bridge.terminal.flush_input(), b'\x1b')

    def test_terminal_reply_handles_short_writes(self):
        sent = bytearray()
        def short_write(fd, data):
            sent.extend(data[:1])
            return 1
        with patch.object(module.os, 'write', side_effect=short_write):
            self.bridge.deliver_terminal(self.bridge.remote, b'\x1b[2;3R')
        self.assertEqual(sent, b'\x1b[2;3R')


if __name__ == '__main__':
    os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')
    unittest.main()
