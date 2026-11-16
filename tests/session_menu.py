"""Cursor/action/state routing regressions using disposable histories and PTYs."""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from cx_sessions import SessionMenu, clean, fit
spec = importlib.util.spec_from_file_location('bridge', ROOT/'bin/cx-ssh-bridge.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ID = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


class MenuTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, CX_DATA_HOME=self.temp.name, CX_SESSION_MENU='1', CX_AGENT='codex', CX_ACCOUNT='work')
        self.env.start()
        self.addCleanup(self.env.stop)
        self.bridge = module.Bridge('host', '/remote', ['/cx', '/project', '--agent', 'codex', '--account', 'work', '--add-dir', '/extra', 'a task not to replay'])
        self.bridge.local = (77, Mock())
        self.bridge.ready, self.bridge.focus = True, 'local'
        self.bridge.notice = Mock()
        self.menu = self.bridge.menu
        self.menu.request = Mock()
        self.menu.rows = [dict(agent='codex', id=ID, name='計画', project='/p', updated=1), dict(agent='claude', id=ID, name='Duplicate', project='/p', updated=1)]
        self.menu.open()

    def test_cursor_and_refresh_preserve_cli_uuid_not_active(self):
        self.menu.active = ('codex', ID)
        self.menu.handle(b'\x1b[B')
        self.assertEqual(self.menu.cursor, 1)
        self.assertEqual(self.menu.active, ('codex', ID))
        self.menu.replace(list(reversed(self.menu.rows)))
        self.assertEqual(self.menu.cursor, 0)
        self.assertEqual(self.menu.selected()['agent'], 'claude')

    def test_pagination_deletion_refresh_and_empty_state(self):
        self.menu.rows = [dict(self.menu.rows[0], id=f'{i:08x}-1111-4111-8111-111111111111') for i in range(50)]
        self.menu.handle(b'\x1b[6~')
        self.assertGreater(self.menu.cursor, 0)
        before = self.menu.cursor
        self.menu.handle(b'\x1b[<65;5;5M')
        self.assertEqual(self.menu.cursor, before+3)
        self.menu.handle(b'\x1b[3~')
        target = self.menu.target.copy()
        self.menu.handle(b'n')
        self.menu.request.assert_called_once_with('list')
        self.menu.handle(b'd'); self.menu.handle(b'y')
        self.menu.request.assert_called_with('remove', agent=target['agent'], id=target['id'])
        self.menu.replace([]); self.menu.draw()
        self.assertIsNone(self.menu.selected())

    def test_rename_target_and_pasted_shortcut_do_not_leak(self):
        self.menu.handle(b'r'); self.menu.handle(b'\x15')
        for byte in '日本語'.encode():
            self.menu.handle(bytes([byte]))
        self.menu.handle(b'\x1b[200~')
        self.menu.handle(b'\x1d'); self.menu.handle(b's'); self.menu.handle(b'\x1b[201~')
        self.assertEqual(self.menu.text, '日本語s')
        self.menu.handle(b'\r')
        self.menu.request.assert_called_with('rename', agent='codex', id=ID, value='日本語s')

    def test_cancel_restores_owner_styles_scroll_and_draft(self):
        self.menu.close()
        owner = self.bridge.local
        self.bridge.terminal.switch(owner, 'CODEX / work')
        self.bridge.terminal.display.feed(owner, b'\x1b[31mDRAFT')
        pane = self.bridge.terminal.display.pane(owner)
        before = pane.screen.display[:]
        pane.screen.scroll_offset = 7
        self.menu.open(); self.menu.handle(b'q')
        self.assertIs(self.bridge.terminal.display.active, owner)
        self.assertEqual(pane.screen.display, before)
        self.assertEqual(pane.screen.scroll_offset, 7)
        self.assertEqual(pane.screen.buffer[0][0].fg, 'red')

    def test_shortcut_from_both_screens_and_paste_does_not_open(self):
        self.menu.close()
        for focus in ('local', 'remote'):
            self.bridge.focus = focus
            self.bridge.keyboard(b'\x1ds')
            self.assertTrue(self.menu.opened)
            self.menu.close()
        self.bridge.focus = 'local'
        with patch.object(self.bridge, 'deliver_terminal') as deliver:
            self.bridge.keyboard(b'\x1b[200~\x1ds\x1b[201~')
            self.assertFalse(self.menu.opened)
            self.assertTrue(deliver.called)

    def test_switch_gates_live_work_and_rechecks_at_clean_handoff(self):
        self.bridge.pending = {'job_id': ID}
        self.menu.choose(self.menu.rows[0], 'work')
        self.assertIsNone(self.menu.queued)
        self.bridge.pending = None
        self.menu.choose(self.menu.rows[0], 'work')
        self.assertIsNotNone(self.menu.queued)
        self.bridge.pending = {'job_id': ID}
        self.assertTrue(self.menu.handoff(0))
        self.assertIsNone(self.menu.queued)

    def test_idle_allocation_and_remote_state_survive_switch(self):
        allocation = {'id': ID, 'ready': True, 'child': None}
        pending = {'job_id': ID}
        self.bridge.interactive, self.bridge.pending = allocation, pending
        self.bridge.start_local = Mock()
        self.bridge.launcher += ['-c', 'features.cli_resume_account_check=true']
        self.menu.choose(self.menu.rows[0], 'work')
        self.bridge.local = None
        self.assertTrue(self.menu.handoff(0))
        self.assertIs(self.bridge.interactive, allocation)
        self.assertIs(self.bridge.pending, pending)
        self.assertEqual(self.bridge.launcher[-2:], ['resume', ID])
        self.assertNotIn('a task not to replay', self.bridge.launcher)
        self.assertIn('/extra', self.bridge.launcher)
        self.assertIn('features.cli_resume_account_check=true', self.bridge.launcher)

    def test_failed_handoff_never_launches_and_active_cannot_delete(self):
        self.menu.choose(self.menu.rows[0], 'work')
        self.bridge.start_local = Mock()
        self.assertTrue(self.menu.handoff(1))
        self.bridge.start_local.assert_not_called()
        self.menu.active = ('codex', ID)
        self.menu.mode = 'list'; self.menu.handle(b'd')
        self.assertEqual(self.menu.mode, 'list')

    def test_ssh_switch_refreshes_guidance_and_keeps_transport(self):
        self.bridge.runtime = self.temp.name
        self.bridge.mount_files = Mock()
        self.bridge.resize = Mock()
        self.bridge.spawn = Mock(return_value=(88, Mock()))
        remote = self.bridge.remote = (99, Mock())
        jobs = self.bridge.jobs
        self.menu.choose(self.menu.rows[1], 'claude-work')
        self.bridge.local = None
        self.assertTrue(self.menu.handoff(0))
        args, env = self.bridge.spawn.call_args.args
        self.assertEqual(args[-2:], ['--resume', ID])
        self.assertIn('host', env['CX_SSH_INSTRUCTIONS'])
        self.assertIn('/remote', env['CX_SSH_INSTRUCTIONS'])
        self.assertIn('Never replay', env['CX_SSH_INSTRUCTIONS'])
        self.assertIs(self.bridge.remote, remote)
        self.assertIs(self.bridge.jobs, jobs)
        self.assertEqual(env['CX_AGENT'], 'claude')
        self.menu.release()

    def test_unicode_sanitization_and_resize(self):
        self.assertNotIn('\x1b', clean('bad\x1b[31m'))
        self.assertEqual(fit('日本語', 4), '日本')
        for rows, columns in ((5, 15), (24, 80), (40, 120)):
            self.bridge.terminal.display.resize(rows, columns)
            self.menu.draw()
            pane = self.bridge.terminal.display.pane(self.menu.owner)
            self.assertEqual(pane.screen.columns, columns)

    def test_worker_startup_failure_keeps_terminal_and_remote_state(self):
        remote = self.bridge.remote = (99, Mock())
        with patch('cx_sessions.subprocess.Popen', side_effect=OSError('unavailable')):
            SessionMenu.request(self.menu, 'list')
        self.assertIs(self.bridge.remote, remote)
        self.assertTrue(self.menu.opened)
        self.assertIsNone(self.menu.worker)
        self.assertIn('No automatic retry', self.menu.message)

    def test_remote_bootstrap_cannot_steal_open_menu_or_route_keys_to_hidden_assistant(self):
        self.bridge.focus = 'remote'
        self.bridge.switch_focus('local')
        self.assertEqual(self.bridge.focus, 'remote')
        self.assertIs(self.bridge.terminal.display.active, self.menu.owner)
        self.bridge.local = None
        self.bridge.runtime = self.temp.name
        self.bridge.mount_files = Mock()
        self.bridge.spawn = Mock(return_value=(88, Mock()))
        self.bridge.resize = Mock()
        self.bridge.start_local()
        self.assertIs(self.bridge.terminal.display.active, self.menu.owner)


class PtyTests(unittest.TestCase):
    def test_local_saved_menu_keystrokes_do_not_enter_native_draft(self):
        with tempfile.TemporaryDirectory(dir=ROOT, prefix='.cx-test-menu-') as directory:
            root = Path(directory)
            fake = root/'launcher'
            log = root/'input'
            fake.write_text('#!'+sys.executable+'\nimport sys,json,os\n'
                            'if sys.argv[1:3]==["sessions","menu-backend"]:\n'
                            ' req=json.load(sys.stdin); print(json.dumps({"rows":[{"agent":"codex","id":"'+ID+'","name":"PTY Session","project":"/p","updated":1}]}));sys.exit(0)\n'
                            'print("NATIVE READY",flush=True)\n'
                            'line=sys.stdin.readline()\n'
                            'open('+repr(str(log))+',"w").write(line)\n')
            fake.chmod(0o755)
            master, slave = os.openpty()
            env = dict(os.environ, CX_DATA_HOME=directory, CX_SESSION_MENU='1', CX_SESSION_CHILD='1', CX_AGENT='codex', CX_ACCOUNT='work')
            process = subprocess.Popen([sys.executable, str(ROOT/'bin/cx-session-supervisor.py'), str(fake), directory], stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            def until(needle):
                output = b''; deadline = time.monotonic()+10
                while needle not in output and time.monotonic()<deadline:
                    if select.select([master], [], [], .1)[0]:
                        try: output += os.read(master, 65536)
                        except OSError: break
                self.assertIn(needle, output)
            try:
                until(b'NATIVE READY')
                os.write(master, b'draft\x1ds')
                until(b'PTY Session')
                os.write(master, b'\x1b[Bq\r')
                process.wait(timeout=10)
                self.assertEqual(log.read_text(), 'draft\n')
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill();process.wait()
                os.close(master)


if __name__ == '__main__':
    unittest.main()
