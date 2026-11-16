"""Cursor/action/state routing regressions using disposable histories and PTYs."""
import importlib.util
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from cx_sessions import SessionMenu, clean, fit, relative_time
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
        self.bridge.runtime = self.temp.name
        self.bridge.mount_files = Mock()
        self.bridge.spawn = Mock(return_value=(88, Mock()))
        self.bridge.resize = Mock()
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
        self.menu.queued = (dict(self.menu.rows[0]), 'work')
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
        self.assertIsNone(self.menu.queued)
        self.assertIs(self.bridge.interactive, allocation)
        self.assertIs(self.bridge.pending, pending)
        self.assertEqual(self.bridge.launcher[-2:], ['resume', ID])
        self.assertNotIn('a task not to replay', self.bridge.launcher)
        self.assertIn('/extra', self.bridge.launcher)
        self.assertIn('features.cli_resume_account_check=true', self.bridge.launcher)

    def test_enter_parks_and_restores_existing_process_and_draft(self):
        old = self.bridge.local
        self.menu.active = ('codex', ID)
        self.bridge.terminal.display.feed(old, b'\x1b[31mUNSENT DRAFT')
        pane = self.bridge.terminal.display.pane(old)
        pane.screen.scroll_offset = 3
        self.menu.choose(dict(self.menu.rows[0], id=OTHER), 'work')
        self.assertIs(self.menu.saved[('codex', ID)]['item'], old)
        self.assertNotEqual(self.bridge.local, old)
        self.assertIsNone(self.menu.queued)
        self.bridge.spawn.assert_called_once()
        self.menu.open()
        self.menu.choose(self.menu.saved[('codex', ID)]['row'], 'work')
        self.assertIs(self.bridge.local, old)
        self.assertIs(self.bridge.terminal.display.active, old)
        self.assertEqual(pane.screen.scroll_offset, 3)
        self.assertEqual(pane.screen.buffer[0][0].fg, 'red')
        self.assertIn('UNSENT DRAFT', '\n'.join(pane.screen.display))
        self.bridge.spawn.assert_called_once()

    def test_unsafe_switch_keeps_original_process_and_clear_reason(self):
        old = self.bridge.local
        for ready, focus, pending in [(False, 'local', None), (True, 'remote', None),
                                       (True, 'local', {'job_id': ID})]:
            self.bridge.ready, self.bridge.focus, self.bridge.pending = ready, focus, pending
            self.menu.choose(self.menu.rows[0], 'work')
            self.assertIs(self.bridge.local, old)
            self.assertFalse(self.menu.saved)
            self.assertTrue(self.menu.opened)
            self.assertIn('Switch refused', self.menu.message)
        self.bridge.spawn.assert_not_called()

    def test_saved_writer_lease_and_unknown_identity_remain_live_until_exit(self):
        lease = Path(self.temp.name)/'writer.json'
        lease.write_text('{}')
        self.menu.lease = lease
        old = self.bridge.local
        self.menu.choose(self.menu.rows[0], 'work')
        saved = next(iter(self.menu.saved.values()))
        self.assertTrue(saved['row']['local_only'])
        self.assertTrue(saved['row']['id'].startswith('live-'))
        self.assertTrue(lease.exists())
        self.menu.background_exited(old, 1)
        self.assertFalse(lease.exists())
        self.assertFalse(self.menu.saved)
        self.assertIn('No command was replayed', self.menu.message)

    def test_resize_includes_background_ptys(self):
        self.menu.choose(self.menu.rows[0], 'work')
        with patch.object(module.fcntl, 'ioctl', return_value=struct.pack('HHHH', 30, 100, 0, 0)) as ioctl:
            module.Bridge.resize(self.bridge)
        resized = [call.args[0] for call in ioctl.call_args_list[1:]]
        self.assertIn(77, resized)
        self.assertIn(88, resized)

    def test_failed_handoff_never_launches_and_active_cannot_delete(self):
        self.menu.queued = (dict(self.menu.rows[0]), 'work')
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
        self.assertIsNone(self.menu.queued)
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

    def test_search_handles_unicode_and_keeps_action_keys_as_search_text(self):
        self.menu.replace(self.menu.rows[:])
        self.menu.handle(b'/')
        for byte in '計画'.encode():
            self.menu.handle(bytes([byte]))
        self.assertEqual(len(self.menu.rows),1)
        self.assertEqual(self.menu.selected()['id'],ID)
        self.menu.handle(b'\x15')
        self.menu.handle(b'q'); self.menu.handle(b'r'); self.menu.handle(b'd')
        self.assertEqual(self.menu.query,'qrd')
        self.assertTrue(self.menu.opened)
        self.menu.request.assert_called_once_with('list')
        self.menu.handle(b'\x15'); self.menu.handle(b'\x1b')
        self.assertEqual(self.menu.mode,'list')
        self.assertEqual(len(self.menu.rows),2)

    def test_native_style_filter_controls_sort_and_density_preserve_identity(self):
        rows=self.menu.rows[:]+[dict(self.menu.rows[0],id=OTHER,name='Archived',archived=True)]
        self.menu.replace(rows)
        self.assertEqual(len(self.menu.rows),2)
        self.menu.handle(b'\t'); self.menu.handle(b'\x1b[C')
        self.assertEqual(self.menu.cli_filter,'Codex')
        self.assertEqual([r['agent'] for r in self.menu.rows],['codex'])
        self.menu.handle(b'\t'); self.menu.handle(b'\x1b[C')
        self.assertEqual(self.menu.status_filter,'Archived')
        self.assertEqual(self.menu.selected()['id'],OTHER)
        self.menu.handle(b'\t'); self.menu.handle(b'\x1b[C')
        self.assertEqual(self.menu.sort,'Updated')
        old=self.menu.page_size(); self.menu.handle(b'\x0f')
        self.assertFalse(self.menu.dense)
        self.assertLess(self.menu.page_size(),old)
        self.assertEqual(self.menu.selected()['id'],OTHER)

    def test_initial_name_sort_and_dense_rows(self):
        self.assertEqual(self.menu.sort, 'Name')
        self.assertTrue(self.menu.dense)
        self.menu.replace([dict(self.menu.rows[0], name='Zulu', updated=900),
                           dict(self.menu.rows[1], name='alpha', updated=1)])
        self.assertEqual([row['name'] for row in self.menu.rows], ['alpha', 'Zulu'])

    def test_metadata_is_separate_and_right_aligned_after_resize(self):
        self.menu.rows = [dict(self.menu.rows[0], name='日本語'*40), self.menu.rows[1]]
        self.menu.active = ('codex', ID)
        for dense in (True, False):
            self.menu.dense = dense
            for width in (120, 80, 38, 25, 15, 80):
                self.bridge.terminal.display.resize(30, width)
                self.menu.draw()
                screen = self.bridge.terminal.display.pane(self.menu.owner).screen
                lines = screen.display
                name = next(line for line in lines if '› 日' in line)
                self.assertIn('*', name)
                if width >= 32:
                    self.assertIn(' │ ', name)
                    self.assertIn('codex · ', name)
                    # The final metadata cell is the last terminal column,
                    # regardless of the Unicode title's width.
                    self.assertNotEqual(screen.buffer[lines.index(name)][width-1].data, ' ')
                else:
                    meta = lines[lines.index(name)+1]
                    self.assertIn('codex · ', meta)
                    self.assertTrue(meta.startswith(' '))
                    self.assertNotIn('codex', name)
                self.assertEqual(self.menu.selected()['id'], ID)

    def test_metadata_dividers_align_and_cli_colors_survive_selection_and_density(self):
        self.menu.rows = [dict(self.menu.rows[0], updated=time.time()),
                          dict(self.menu.rows[1], updated=1)]
        for dense in (True, False):
            self.menu.dense = dense
            for width in (120, 80, 38, 25, 80):
                self.bridge.terminal.display.resize(30, width)
                for selected in (0, 1):
                    self.menu.cursor = selected
                    self.menu.draw()
                    screen = self.bridge.terminal.display.pane(self.menu.owner).screen
                    row_numbers = [next(i for i, line in enumerate(screen.display) if name in line)
                                   for name in ('計画', 'Duplicate')]
                    if width >= 32:
                        dividers = [next(col for col, char in screen.buffer[i].items() if char.data == '│')
                                    for i in row_numbers]
                        self.assertEqual(dividers[0], dividers[1])
                        # A short relative time gets left padding inside the
                        # same metadata column as an older, longer timestamp.
                        self.assertIn(' │   ', screen.display[row_numbers[0]])
                    for index, color in enumerate(('87cefa', 'd97757')):
                        char = next(char for char in screen.buffer[row_numbers[index]].values() if char.data in ('計', 'D'))
                        self.assertEqual(char.fg, color)
                        self.assertEqual(char.bold, index == selected)

    def test_internal_toggle_is_explicit_and_marked(self):
        internal=dict(self.menu.rows[0],id=OTHER,name='Guardian review',internal=True)
        self.menu.replace(self.menu.rows+[internal])
        self.assertFalse(any(r.get('internal') for r in self.menu.rows))
        self.menu.handle(b'\x1bOQ')
        self.assertTrue(self.menu.include_internal)
        self.assertTrue(any(r.get('internal') for r in self.menu.rows))
        self.menu.request.assert_called_with('list')
        self.menu.handle(b'\x1bOQ')
        self.assertFalse(any(r.get('internal') for r in self.menu.rows))

    def test_native_style_layout_relative_times_and_small_terminal(self):
        self.assertEqual(relative_time(100,now=110),'just now')
        self.assertEqual(relative_time(100,now=400),'5m ago')
        self.assertEqual(relative_time(100,now=7300),'2h ago')
        for rows,columns in [(30,118),(24,80),(12,38)]:
            self.bridge.terminal.display.resize(rows,columns)
            self.menu.draw()
            screen=self.bridge.terminal.display.pane(self.menu.owner).screen
            text='\n'.join(screen.display)
            self.assertIn('Resume a previous session',text)
            self.assertIn('› 計画',text)
            self.assertIn('Enter resume',text)
            self.assertIn('1 / 2',text)
            self.assertIn('Assistant: Codex',text)
            self.assertIn('Account: work',text)
        self.menu.handle(b'd')
        text='\n'.join(self.bridge.terminal.display.pane(self.menu.owner).screen.display)
        self.assertIn(ID,text)
        self.assertIn('ALL accounts',text)
        self.assertIn('cannot be undone',text)

    def test_menu_banner_is_simple_and_prior_header_is_restored(self):
        display=self.bridge.terminal.display
        display.notice('A transient transport notice')
        self.assertEqual(display.header().strip(),'Sessions  --  Ctrl-] ?: Help Menu')
        self.menu.close()
        self.bridge.terminal.switch(self.bridge.local,'CODEX / work')
        self.assertIn('CODEX/work',display.header())
        self.assertIn('Ctrl-] ?: Help Menu',display.header())
        self.menu.open()
        self.assertEqual(display.header().strip(),'Sessions  --  Ctrl-] ?: Help Menu')

    def test_local_banners_offer_sessions_without_an_ssh_shortcut(self):
        spec=importlib.util.spec_from_file_location('local_bridge',ROOT/'bin/cx-session-supervisor.py')
        local_module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(local_module)
        bridge=local_module.LocalBridge('','',['/cx','/project'])
        self.assertNotIn('SSH',bridge.terminal.display.header())
        bridge.spawn=Mock(return_value=(88,Mock()))
        bridge.resize=Mock()
        bridge.start_local()
        self.assertIn('Ctrl-] ?: Help Menu',bridge.terminal.display.header())
        self.assertNotIn('SSH',bridge.terminal.display.header())

    def test_transport_notice_is_visible_below_the_compact_menu_banner(self):
        module.Bridge.notice(self.bridge,'SSH disconnected; command outcome unknown.')
        self.assertEqual(self.bridge.terminal.display.header().strip(),'Sessions  --  Ctrl-] ?: Help Menu')
        screen=self.bridge.terminal.display.pane(self.menu.owner).screen
        self.assertIn('SSH disconnected; command outcome unknown.','\n'.join(screen.display))

    def test_worker_startup_failure_keeps_terminal_and_remote_state(self):
        remote = self.bridge.remote = (99, Mock())
        with patch('cx_sessions.subprocess.Popen', side_effect=OSError('unavailable')):
            SessionMenu.request(self.menu, 'list')
        self.assertIs(self.bridge.remote, remote)
        self.assertTrue(self.menu.opened)
        self.assertIsNone(self.menu.worker)
        self.assertIn('No automatic retry', self.menu.message)

    def test_failed_native_start_does_not_tear_down_ssh_or_replay_task(self):
        remote = self.bridge.remote = (99, Mock())
        old = self.bridge.local
        self.bridge.start_local = Mock(side_effect=ValueError('reserved server'))
        self.menu.choose(self.menu.rows[0], 'work')
        self.assertIs(self.bridge.remote, remote)
        self.assertTrue(self.menu.opened)
        self.assertIsNone(self.menu.active)
        self.assertIn('reserved server', self.menu.message)
        self.assertIn('remote state is retained', self.menu.message)
        self.bridge.start_local.assert_called_once()
        self.menu.handle(b'q')
        self.assertIs(self.bridge.local, old)
        self.assertFalse(self.menu.opened)
        self.bridge.start_local.assert_called_once()

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


class HelpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, CX_DATA_HOME=self.temp.name, CX_SESSION_MENU='1', CX_AGENT='claude', CX_ACCOUNT='work')
        env.start(); self.addCleanup(env.stop)
        self.bridge = module.Bridge('host', '/remote', ['/cx', '/project'])
        self.bridge.local, self.bridge.remote = (77, Mock()), (99, Mock())
        self.bridge.focus, self.bridge.ready = 'local', True
        self.bridge.terminal.switch(self.bridge.local, self.bridge.assistant_label)
        self.bridge.menu.request = Mock()
        self.bridge.menu.rows = [dict(agent='claude', id=ID, name='Session', project='/p', updated=1)]
        self.writer = patch.object(module.os, 'write', side_effect=lambda fd, data: len(data))
        self.write = self.writer.start(); self.addCleanup(self.writer.stop)

    def test_both_cli_account_labels_and_ssh_identity_survive_help(self):
        for agent in ('codex', 'claude'):
            for account in ('personal', '研究'):
                label = agent.upper()+' / '+account
                self.bridge.terminal.switch(self.bridge.local, label)
                self.bridge.help.open()
                self.assertEqual(self.bridge.terminal.display.header().strip(), agent.upper()+'/'+account+'  --  Ctrl-] ?: Help Menu')
                self.bridge.help.close()
                self.assertEqual(self.bridge.terminal.display.label, label)
        self.bridge.terminal.switch(self.bridge.remote, 'SSH')
        self.bridge.help.open()
        self.assertEqual(self.bridge.terminal.display.label, 'SSH')
        self.assertEqual(self.bridge.terminal.display.header().strip(), 'SSH  --  Ctrl-] ?: Help Menu')
        self.bridge.help.close()
        self.write.assert_not_called()

    def test_help_alias_palette_and_restored_banner(self):
        display = self.bridge.terminal.display
        self.bridge.help.open()
        self.assertEqual(display.header_styles[self.bridge.help.owner], '0;30;43')
        screen = display.pane(self.bridge.help.owner).screen
        title = next(i for i, line in enumerate(screen.display) if line.startswith('Help Menu'))
        self.assertEqual(screen.buffer[title][0].fg, 'brightbrown')
        key = next(i for i, line in enumerate(screen.display) if 'Ctrl-] ?' in line)
        self.assertEqual(screen.buffer[key][1].bg, 'brown')
        self.assertEqual(screen.buffer[key][1].fg, 'black')
        self.bridge.help.close()
        self.assertNotIn(display.active, display.header_styles)

    def test_badges_have_one_space_and_descriptions_align(self):
        display = self.bridge.terminal.display
        display.resize(120, 100)
        self.bridge.help.open()
        screen = display.pane(self.bridge.help.owner).screen
        columns = []
        entries = list(self.bridge.help.entries())
        self.assertFalse({'Safety', 'Native input', 'Scrollback', 'Sessions state', 'Help navigation'} & {key for key, _ in entries})
        for key, _ in entries:
            row = next(i for i, line in enumerate(screen.display) if line.startswith(' '+key+' '))
            cells = screen.buffer[row]
            badge = ''.join(cells[x].data for x in range(screen.columns) if cells[x].bg == 'brown')
            self.assertEqual(badge, ' '+key+' ')
            end = len(key)+2
            columns.append(next(x for x in range(end, screen.columns) if cells[x].data != ' '))
        self.assertEqual(len(set(columns)), 1)
        self.bridge.help.close()

    def test_connection_banner_advertises_only_help(self):
        self.bridge.terminal.render = Mock()
        self.bridge.connection_help()
        text = self.bridge.terminal.render.call_args.args[1].decode()
        self.assertIn('SSH  --  Ctrl-] ?: Help Menu', text)
        self.assertNotIn('Ctrl-] r', text)
        self.assertNotIn('Ctrl-] c', text)

    def test_open_close_keeps_focus_draft_history_and_busy_state(self):
        for focus, ready in (('remote', False), ('local', True)):
            self.bridge.focus, self.bridge.ready = focus, ready
            owner = self.bridge.remote if focus == 'remote' else self.bridge.local
            self.bridge.terminal.switch(owner, 'SSH' if focus == 'remote' else self.bridge.assistant_label)
            pane = self.bridge.terminal.display.pane(owner)
            pane.feed(b'\033[31mUNSENT DRAFT')
            pane.screen.scroll_offset = 4
            before = pane.screen.display[:]
            pending = self.bridge.pending = {'job_id': ID}
            interactive = self.bridge.interactive = {'ready': False}
            self.bridge.keyboard(b'\x1d?')
            self.assertTrue(self.bridge.help.opened)
            self.assertIs(self.bridge.terminal.display.active, self.bridge.help.owner)
            self.bridge.keyboard(b'\x1d?')
            self.bridge.help.handle(b'\x1b')
            self.assertFalse(self.bridge.help.opened)
            self.assertIs(self.bridge.terminal.display.active, owner)
            self.assertEqual(self.bridge.focus, focus)
            self.assertEqual(self.bridge.ready, ready)
            self.assertIs(self.bridge.pending, pending)
            self.assertIs(self.bridge.interactive, interactive)
            self.assertEqual(pane.screen.display, before)
            self.assertEqual(pane.screen.scroll_offset, 4)
            self.assertEqual(pane.screen.buffer[0][0].fg, 'red')
        self.write.assert_not_called()

    def test_help_restores_every_sessions_modal_and_filter(self):
        menu = self.bridge.menu
        menu.open()
        menu.query, menu.cli_filter, menu.control = 'Session', 'Claude', 'sort'
        menu.target, menu.account_rows, menu.account_index = menu.rows[0], ['work'], 0
        for mode in ('list', 'search', 'rename', 'delete', 'account'):
            menu.mode, menu.text = mode, 'Unsent 日本語?'
            menu.draw()
            before = (menu.mode, menu.text, menu.query, menu.cursor, menu.control, menu.target, menu.account_index)
            self.bridge.keyboard(b'\x1d?')
            self.assertTrue(self.bridge.help.opened, mode)
            self.assertEqual(menu.mode, mode)
            self.assertIn('Enter', [key for key, _ in self.bridge.help.entries()])
            self.bridge.help.handle(b'\x1b')
            self.assertEqual((menu.mode, menu.text, menu.query, menu.cursor, menu.control, menu.target, menu.account_index), before)
            self.assertIs(self.bridge.terminal.display.active, menu.owner)
        menu.request.assert_called_once_with('list')
        self.write.assert_not_called()

    def test_bare_question_and_paste_never_open_help(self):
        self.bridge.keyboard(b'?')
        self.write.assert_called_with(77, b'?')
        self.bridge.keyboard(b'\x1b[200~\x1d?\x1b[201~')
        self.assertFalse(self.bridge.help.opened)
        self.bridge.menu.open()
        self.bridge.menu.mode, self.bridge.menu.text = 'rename', ''
        self.bridge.menu.target = self.bridge.menu.rows[0]
        self.bridge.keyboard(b'\x1b[200~\x1d?\x1b[201~')
        self.assertEqual(self.bridge.menu.text, '?')
        self.assertFalse(self.bridge.help.opened)

    def test_help_scroll_resize_repeat_and_paste_are_isolated(self):
        self.bridge.help.open()
        owners = set(self.bridge.terminal.display.panes)
        self.bridge.help.open()
        self.assertEqual(set(self.bridge.terminal.display.panes), owners)
        self.bridge.keyboard(b'\x1b[6~')
        self.assertGreater(self.bridge.help.top, 0)
        for width in (120, 40, 15, 80):
            self.bridge.terminal.display.resize(12, width)
            self.bridge.help.draw()
            self.assertLessEqual(self.bridge.help.top, self.bridge.help.limit)
            self.assertIn('Ctrl-] ?', self.bridge.terminal.display.header())
        self.bridge.keyboard(b'\x1b[200~\x1b\x1dq\x1b[201~')
        self.assertTrue(self.bridge.help.opened)
        self.assertTrue(self.bridge.running)
        self.bridge.keyboard(b'\x1dq')
        self.assertFalse(self.bridge.running)
        self.write.assert_not_called()

    def test_disconnected_and_legacy_local_help_report_unavailable_controls(self):
        self.bridge.host, self.bridge.remote, self.bridge.ready, self.bridge.menu = '', None, False, None
        self.bridge.help.open()
        text = '\n'.join(description for _, description in self.bridge.help.entries())
        self.assertIn('Unavailable in local mode', text)
        self.assertIn('Unavailable in legacy mode', text)
        self.bridge.notice('SSH disconnected; outcome unknown. '*10)
        self.assertNotIn('outcome', self.bridge.terminal.display.header())
        self.assertIn('Ctrl-] ?: Help Menu', self.bridge.terminal.display.header())
        self.bridge.help.handle(b'\x1b')
        self.assertIn('outcome unknown', self.bridge.terminal.display.status())
        self.write.assert_not_called()

    def test_underlying_view_change_does_not_dismiss_help(self):
        self.bridge.help.open()
        self.bridge.menu.open()
        self.bridge.help.retain()
        self.assertIs(self.bridge.terminal.display.active, self.bridge.help.owner)
        self.bridge.help.handle(b'\x1b')
        self.assertIs(self.bridge.terminal.display.active, self.bridge.menu.owner)


class PtyTests(unittest.TestCase):
    def test_enter_switches_without_exit_and_return_keeps_original_draft(self):
        with tempfile.TemporaryDirectory(dir=ROOT, prefix='.cx-test-switch-') as directory:
            root = Path(directory)
            (root/'profiles/codex/work').mkdir(parents=True)
            launcher, launches, draft = root/'launcher', root/'launches', root/'draft'
            progress, emitted = root/'progress', root/'emitted'
            rows = [dict(agent='codex', id=ID, name='Alpha', project='/p', updated=1),
                    dict(agent='codex', id=OTHER, name='Beta', project='/p', updated=2)]
            launcher.write_text('#!'+sys.executable+'\nimport sys,json,time,threading\nfrom pathlib import Path\n'
                'if sys.argv[1:3]==["sessions","menu-backend"]:\n'
                ' json.load(sys.stdin); print('+repr(json.dumps(dict(rows=rows)))+');sys.exit(0)\n'
                'identity=sys.argv[-1]\n'
                'with open('+repr(str(launches))+',"a") as f:f.write(identity+"\\n")\n'
                'print("READY "+identity,flush=True)\n'
                'def background():\n'
                ' while not Path('+repr(str(progress))+').exists():time.sleep(.01)\n'
                ' print("BACKGROUND PROGRESS",flush=True)\n'
                ' Path('+repr(str(emitted))+').touch()\n'
                'if identity=='+repr(ID)+':threading.Thread(target=background,daemon=True).start()\n'
                'line=sys.stdin.readline()\n'
                'with open('+repr(str(draft))+',"a") as f:f.write(identity+":"+line)\n')
            launcher.chmod(0o755)
            master, slave = os.openpty()
            env = dict(os.environ, CX_DATA_HOME=directory, CX_SESSION_MENU='1', CX_SESSION_CHILD='1', CX_AGENT='codex', CX_ACCOUNT='work')
            process = subprocess.Popen([sys.executable, str(ROOT/'bin/cx-session-supervisor.py'),
                str(launcher), directory, 'resume', ID], stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            buffered = b''
            def until(needle):
                nonlocal buffered
                deadline = time.monotonic()+10
                while needle not in buffered and time.monotonic()<deadline:
                    if select.select([master], [], [], .1)[0]:
                        try: buffered += os.read(master, 65536)
                        except OSError: break
                self.assertIn(needle, buffered)
                buffered = buffered.split(needle, 1)[1]
            try:
                until(('READY '+ID).encode())
                os.write(master, b'unsent draft\x1ds')
                until(b'Alpha')
                os.write(master, b'\x1b[B\r')
                until(('READY '+OTHER).encode())
                self.assertFalse(draft.exists(), 'switching must not submit or exit the old draft')
                progress.touch()
                deadline = time.monotonic()+5
                while not emitted.exists() and time.monotonic()<deadline:
                    time.sleep(.01)
                self.assertTrue(emitted.exists())
                os.write(master, b'\x1ds')
                until(b'Loading...')
                until(b'Internal threads hidden')
                os.write(master, b'\x1b[A\r')
                until(b'unsent draft')
                until(b'BACKGROUND PROGRESS')
                os.write(master, b'\r')
                until(b'Assistant exited.')
                self.assertEqual(draft.read_text(), ID+':unsent draft\n')
                self.assertEqual(launches.read_text().splitlines(), [ID, OTHER])
                os.write(master, b'\x1dq')
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.terminate(); process.wait(timeout=10)
                os.close(master)

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
                os.write(master, b'NATIVE-DRAFT-XYZ\x1d?')
                until(b'Open Help Menu.')
                os.write(master, b'\x1b')
                until(b'NATIVE-DRAFT-XYZ')
                os.write(master, b'\x1ds')
                until(b'PTY Session')
                os.write(master, b'\x1b[Bq\r')
                process.wait(timeout=10)
                self.assertEqual(log.read_text(), 'NATIVE-DRAFT-XYZ\n')
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill();process.wait()
                os.close(master)


if __name__ == '__main__':
    unittest.main()
