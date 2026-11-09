#!/usr/bin/env python3
"""Screen isolation, colors, alternate buffers, sizing, and native VT checks."""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from cx_screen import Pane, SessionDisplay


class ScreenTests(unittest.TestCase):
    def setUp(self):
        self.output = bytearray()
        def write(fd, data):
            self.output.extend(data)
            return len(data)
        self.writer = patch('os.write', side_effect=write)
        self.writer.start()
        self.addCleanup(self.writer.stop)
        self.remote, self.local = object(), object()
        self.display = SessionDisplay(lambda *args: None)
        self.physical = Pane(60, 12, lambda *args: None)
        self.physical.feed(b'HOST-PROMPT')
        self.display.start(12, 60)
        self.display.select(self.remote, 'SSH')

    def draw(self):
        self.display.paint(force=True)
        self.physical.feed(bytes(self.output))
        self.output.clear()
        return self.physical.screen

    def assert_bar(self, screen, name, color):
        self.assertTrue(screen.display[0].startswith(' ' + name))
        for x in range(screen.columns):
            self.assertEqual(screen.buffer[0][x].bg, color, (x, screen.buffer[0][x]))

    def test_full_width_green_and_blue_labels(self):
        self.assert_bar(self.draw(), 'SSH', 'green')
        self.display.select(self.local, 'CODEX')
        self.assert_bar(self.draw(), 'CODEX', 'blue')

    def test_screens_restore_without_background_output_leakage(self):
        self.display.feed(self.remote, b'SSH-ONLY-TEXT')
        self.assertIn('SSH-ONLY-TEXT', self.draw().display[1])
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'CODEX-ONLY-TEXT')
        self.display.feed(self.remote, b'\r\nSSH-BACKGROUND-TEXT')
        screen = self.draw()
        self.assertIn('CODEX-ONLY-TEXT', screen.display[1])
        self.assertNotIn('SSH-', '\n'.join(screen.display[1:]))
        self.display.select(self.remote, 'SSH')
        screen = self.draw()
        self.assertIn('SSH-BACKGROUND-TEXT', '\n'.join(screen.display[1:]))
        self.assertNotIn('CODEX-', '\n'.join(screen.display[1:]))

    def test_hidden_codex_updates_survive_repeated_switches(self):
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'\x1b[2J\x1b[HINITIAL-CODEX')
        self.draw()
        self.display.select(self.remote, 'SSH')
        self.display.feed(self.remote, b'\r\nSSH-NOISE' * 30)
        self.display.feed(self.local, b'\x1b[2J\x1b[HFRESH-CODEX\x1b[3;2HSECOND-LINE')
        for _ in range(5):
            self.display.select(self.local, 'CODEX')
            screen = self.draw()
            self.assertIn('FRESH-CODEX', screen.display[1])
            self.assertIn('SECOND-LINE', screen.display[3])
            self.assertNotIn('SSH-NOISE', '\n'.join(screen.display))
            self.display.select(self.remote, 'SSH')
            self.draw()

    def test_application_alternate_screen_has_its_own_saved_content(self):
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'MAIN-SCREEN\x1b[?1049h\x1b[2J\x1b[HALTERNATE-SCREEN')
        self.assertIn('ALTERNATE-SCREEN', self.draw().display[1])
        self.display.select(self.remote, 'SSH')
        self.display.feed(self.remote, b'OTHER-SCREEN')
        self.draw()
        self.display.select(self.local, 'CODEX')
        self.assertIn('ALTERNATE-SCREEN', self.draw().display[1])
        self.display.feed(self.local, b'\x1b[?1049l')
        self.assertIn('MAIN-SCREEN', self.draw().display[1])

    def test_clear_scroll_and_cursor_home_cannot_overwrite_header(self):
        self.display.feed(self.remote, b'line\r\n' * 50)
        self.display.feed(self.remote, b'\x1b[2J\x1b[HNEW-SCREEN\x1b[1;4r\x1b[4;1Hscroll\r\n')
        self.assert_bar(self.draw(), 'SSH', 'green')

    def test_resize_redraws_full_header_and_keeps_one_reserved_row(self):
        self.draw()
        self.display.resize(8, 38)
        self.physical.resize(38, 8)
        screen = self.draw()
        self.assertEqual(self.display.pane(self.remote).screen.lines, 7)
        self.assertEqual(self.display.pane(self.remote).screen.columns, 38)
        self.assert_bar(screen, 'SSH', 'green')
        self.display.resize(18, 80)
        self.physical.resize(80, 18)
        self.assert_bar(self.draw(), 'SSH', 'green')

    def test_unicode_styles_and_split_utf8(self):
        self.display.select(self.local, 'CODEX')
        encoded = 'é猫🐈'.encode()
        self.display.feed(self.local, b'\x1b[38;2;12;34;56m')
        for byte in encoded:
            self.display.feed(self.local, bytes([byte]))
        screen = self.draw()
        self.assertIn('é猫🐈', screen.display[1])
        self.assertEqual(screen.buffer[1][0].fg, '0c2238')
        self.assert_bar(screen, 'CODEX', 'blue')

    def test_unsupported_controls_do_not_print_literal_suffixes(self):
        self.display.select(self.local, 'CODEX')
        for packet in (b'before', b'\x1b[4:', b'3munderlined', b'\x1b[24m',
                       b'\x1b[!p', b'after', b'\x1bPignored-terminal-string\x1b\\'):
            self.display.feed(self.local, packet)
        line = self.draw().display[1].rstrip()
        self.assertEqual(line, 'beforeunderlinedafter')

    def test_dim_placeholder_background_and_reset_survive_switching(self):
        self.display.select(self.local, 'CODEX')
        prompt = b'\x1b[48;5;236m\x1b[2mAsk Codex anything\x1b[K\x1b[22m!\x1b[0m?'
        for byte in prompt:
            self.display.feed(self.local, bytes([byte]))
        screen = self.draw()
        char = screen.buffer[1][0]
        self.assertTrue(char.dim)
        self.assertEqual(char.bg, 'idx:236')
        self.assertFalse(screen.buffer[1][18].dim)
        self.assertEqual(screen.buffer[1][18].bg, 'idx:236')
        self.assertEqual(screen.buffer[1][19].bg, 'default')
        self.assertEqual(screen.buffer[1][25].bg, 'idx:236')
        self.display.select(self.remote, 'SSH')
        self.display.feed(self.remote, b'\x1b[31mREMOTE')
        self.draw()
        self.display.select(self.local, 'CODEX')
        screen = self.draw()
        self.assertTrue(screen.buffer[1][0].dim)
        self.assertEqual(screen.buffer[1][0].bg, 'idx:236')

    def test_indexed_colors_remain_palette_references(self):
        self.display.feed(self.remote, b'\x1b[38;5;1;48;5;12mTHEME\x1b[0m')
        screen = self.draw()
        self.assertEqual(screen.buffer[1][0].fg, 'idx:1')
        self.assertEqual(screen.buffer[1][0].bg, 'idx:12')
        self.display.feed(self.remote, b'\x1b[105mMAGENTA')
        self.assertEqual(self.draw().buffer[1][5].bg, 'brightmagenta')

    def test_full_text_styles_colon_colors_and_underlines_round_trip(self):
        self.display.feed(self.remote, b'\x1b[1;2;3;4:3;7;8;9;53;38:2::12:34:56;48:5:238;58:2::90:80:70mX'
                          b'\x1b[22;23;24;27;28;29;55;39;49;59mY')
        screen = self.draw()
        char = screen.buffer[1][0]
        for flag in ('bold', 'dim', 'italics', 'underscore', 'reverse', 'hidden', 'strikethrough', 'overline'):
            self.assertTrue(getattr(char, flag), flag)
        self.assertEqual(char.fg, '0c2238')
        self.assertEqual(char.bg, 'idx:238')
        self.assertEqual(char.underline_style, 3)
        self.assertEqual(char.underline_color, '5a5046')
        reset = screen.buffer[1][1]
        for flag in ('bold', 'dim', 'italics', 'underscore', 'reverse', 'hidden', 'strikethrough', 'overline'):
            self.assertFalse(getattr(reset, flag), flag)
        self.assertEqual((reset.fg, reset.bg, reset.underline_color), ('default',) * 3)

    def test_bad_color_parameters_do_not_drop_following_text(self):
        self.display.feed(self.remote, b'\x1b[38;5;999mA\x1b[48;2;999;2;3mB\x1b[58:2:1mC\x1b[0mD')
        self.assertEqual(self.draw().display[1].rstrip(), 'ABCD')

    def test_scrollback_is_styled_and_pinned_while_output_continues(self):
        self.display.feed(self.remote, b'\x1b[2;32m' + b''.join(f'line-{i:02d}\r\n'.encode() for i in range(35)))
        live = self.draw().display[1:]
        cursor = (self.display.pane(self.remote).screen.cursor.x, self.display.pane(self.remote).screen.cursor.y)
        self.display.scroll(self.remote, 6)
        screen = self.draw()
        history = screen.display[1:]
        self.assertNotEqual(history, live)
        self.assertTrue(screen.buffer[1][0].dim)
        self.assertEqual(screen.buffer[1][0].fg, 'green')
        self.assertIn('HISTORY +6', screen.display[0])
        self.assertTrue(screen.cursor.hidden)
        self.display.feed(self.remote, b'new-output\r\n')
        self.assertEqual(self.draw().display[1:], history)
        self.assertEqual((self.display.pane(self.remote).screen.cursor.x,
                          self.display.pane(self.remote).screen.cursor.y), cursor)
        self.display.follow(self.remote)
        screen = self.draw()
        self.assertNotIn('HISTORY', screen.display[0])
        self.assertIn('new-output', '\n'.join(screen.display[1:]))
        self.assertFalse(screen.cursor.hidden)

    def test_alternate_scrollback_and_scroll_positions_are_independent(self):
        self.display.feed(self.remote, b''.join(f'SSH-{i}\r\n'.encode() for i in range(30)))
        self.display.scroll(self.remote, 4)
        ssh = self.draw().display[1:]
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'NORMAL\x1b[?1049h' + b''.join(f'CHAT-{i}\r\n'.encode() for i in range(35)))
        self.display.scroll(self.local, 7)
        codex = self.draw().display[1:]
        self.assertNotIn('SSH-', '\n'.join(codex))
        self.display.select(self.remote, 'SSH')
        self.assertEqual(self.draw().display[1:], ssh)
        self.display.select(self.local, 'CODEX')
        self.assertEqual(self.draw().display[1:], codex)
        self.display.feed(self.local, b'\x1b[?1049l')
        self.assertTrue(self.draw().display[1].startswith('NORMAL'))
        self.assertEqual(self.display.pane(self.local).screen.scroll_offset, 0)

    def test_scrollback_limits_clear_and_resize(self):
        self.display.feed(self.remote, b'line\r\n' * 2020)
        pane = self.display.pane(self.remote)
        self.assertEqual(len(pane.screen.history.top), 2000)
        self.display.scroll(self.remote, 9999)
        self.assertEqual(pane.screen.scroll_offset, 2000)
        self.display.feed(self.remote, b'new\r\n')
        self.assert_bar(self.draw(), 'SSH', 'green')
        self.display.resize(8, 38)
        self.physical.resize(38, 8)
        self.assert_bar(self.draw(), 'SSH', 'green')
        self.display.feed(self.remote, b'\x1b[3J')
        self.assertEqual(pane.screen.scroll_offset, 0)
        self.assertEqual(len(pane.screen.history.top), 0)

    def test_explicit_scroll_commands_retain_history_styles_and_cursor(self):
        self.display.feed(self.remote, b'\x1b[2;34mTOP\x1b[2;1HSECOND\x1b[5;8H\x1b[1S')
        pane = self.display.pane(self.remote)
        self.assertTrue(self.draw().display[1].startswith('SECOND'))
        self.assertEqual((pane.screen.cursor.y, pane.screen.cursor.x), (4, 7))
        self.display.scroll(self.remote, 1)
        screen = self.draw()
        self.assertTrue(screen.display[1].startswith('TOP'))
        self.assertTrue(screen.buffer[1][0].dim)
        self.assertEqual(screen.buffer[1][0].fg, 'blue')
        self.display.follow(self.remote)
        self.display.feed(self.remote, b'\x1b[T')
        screen = self.draw()
        self.assertTrue(screen.display[2].startswith('SECOND'))
        self.assertEqual((pane.screen.cursor.y, pane.screen.cursor.x), (4, 7))

    def test_malformed_controls_do_not_break_subsequent_output(self):
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'before\x1b[1;2;3Hafter\x1b[?4mend')
        self.assertEqual(self.draw().display[1].rstrip(), 'beforeafterend')

    def test_notice_only_changes_the_bar(self):
        self.display.select(self.local, 'CODEX')
        self.display.feed(self.local, b'READABLE-CODEX-OUTPUT')
        before = self.draw().display[1:]
        self.display.notice('SSH reconnected')
        screen = self.draw()
        self.assertEqual(screen.display[1:], before)
        self.assertIn('SSH reconnected', screen.display[0])
        self.assert_bar(screen, 'CODEX', 'blue')

    def test_exiting_restores_the_enclosing_terminal(self):
        self.display.feed(self.remote, b'SSH-SESSION')
        self.draw()
        self.display.close()
        self.physical.feed(bytes(self.output))
        self.assertTrue(self.physical.screen.display[0].startswith('HOST-PROMPT'))
        self.assertNotIn('SSH-SESSION', '\n'.join(self.physical.screen.display))

    def test_small_terminal_does_not_draw_below_its_height(self):
        self.display.resize(1, 8)
        self.physical.resize(8, 1)
        self.assert_bar(self.draw(), 'SSH', 'green')

    def test_runtime_imports_without_site_packages(self):
        code = ('import sys; sys.path.insert(0, ' + repr(str(ROOT / 'bin')) + '); '
                'import cx_screen, pyte, wcwidth; '
                'assert "vendor" in pyte.__file__; assert "vendor" in wcwidth.__file__')
        subprocess.run([sys.executable, '-S', '-B', '-c', code], check=True)


@unittest.skipUnless(shutil.which('tmux'), 'optional native VT check needs test-only tmux')
class NativeTerminalTests(unittest.TestCase):
    """tmux is an independent test terminal, never a cx runtime dependency."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.cx-test-screen-', dir=ROOT)
        self.home = Path(self.temp.name)
        self.socket = str(self.home / 'terminal.sock')
        self.env = dict(os.environ, PATH=str(self.home) + ':' + os.environ['PATH'],
                        PYTHONDONTWRITEBYTECODE='1', TERM='xterm-256color')
        self.env.pop('TMUX', None)
        self.env.pop('TMUX_PANE', None)
        fake = self.home / 'ssh'
        fake.write_text('#!/bin/bash\nprintf "AUTH challenge: "\nread -rs answer\n'
                        '[[ "$answer" == test-code ]] || exit 1\n'
                        'printf "\\nSSH-PRIVATE-SCREEN\\n"\nexec bash --noprofile --norc -i\n')
        fake.chmod(0o755)
        launcher = self.home / 'local.py'
        launcher.write_text('''import os, signal
from pathlib import Path
Path(__file__).with_suffix('.pid').write_text(str(os.getpid()))
signal.signal(signal.SIGUSR1, lambda *args: print('\\r\\nCODEX-BACKGROUND-UPDATE', flush=True))
print("\\033[?1049h\\033[2J\\033[HCODEX-READABLE", flush=True)
def resize(*args):
    size = os.get_terminal_size()
    print("\\r\\nPTY-SIZE:%d:%d" % (size.lines, size.columns), flush=True)
signal.signal(signal.SIGWINCH, resize)
resize()
while True:
    line = input()
    if line == 'quit': break
    if line == 'history':
        for i in range(50):
            print('\\033[2;38;5;6;48;5;236mCHAT-LINE-%02d\\033[0m' % i, flush=True)
        continue
    print('CODEX-RESPONSE:' + line, flush=True)
''')
        self.tmux('new-session', '-d', '-P', '-s', 'cx-test', '-x', '80', '-y', '24',
                  sys.executable, '-B', str(ROOT / 'bin/cx-ssh-bridge.py'), 'delta', '',
                  sys.executable, str(launcher))
        self.tmux('set-option', '-g', 'status', 'off')
        self.until('AUTH challenge:')
        self.switch('r')
        self.switch('r')
        self.tmux('send-keys', '-t', 'cx-test', '-l', 'test-code')
        self.tmux('send-keys', '-t', 'cx-test', 'Enter')
        self.until('SSH-PRIVATE-SCREEN')
        self.switch('c')
        self.until('CODEX-READABLE')

    def tearDown(self):
        self.tmux('send-keys', '-t', 'cx-test', '-H', '1d', '71', check=False)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            self.tmux('has-session', '-t', 'cx-test', check=False)
            if self.last_status:
                break
            time.sleep(.05)
        self.tmux('kill-server', check=False)
        self.temp.cleanup()

    def tmux(self, *args, check=True):
        result = subprocess.run(['tmux', '-S', self.socket, '-f', '/dev/null', *args],
                                env=self.env, capture_output=True, text=True)
        self.last_status = result.returncode
        if check and result.returncode:
            self.fail(result.stderr)
        return result.stdout

    def capture(self):
        return self.tmux('capture-pane', '-p', '-e', '-N', '-t', 'cx-test')

    def until(self, text, row=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = self.capture()
            plain = re.sub(r'\x1b\[[0-9;]*m', '', result).splitlines()
            if text in result and (row is None or row < len(plain) and text in plain[row]):
                return result
            time.sleep(.05)
        self.fail('Missing ' + text + '\n' + self.capture())

    def switch(self, key):
        self.tmux('send-keys', '-t', 'cx-test', '-H', '1d', f'{ord(key):02x}')

    def test_native_switch_restores_only_the_selected_screen_and_colors(self):
        codex = self.until('CODEX-READABLE')
        self.assertNotIn('SSH-PRIVATE-SCREEN', codex)
        self.assertRegex(codex.splitlines()[0], r'\x1b\[[0-9;]*44m')
        for _ in range(3):
            self.switch('r')
            ssh = self.until('SSH-PRIVATE-SCREEN')
            self.assertNotIn('CODEX-READABLE', ssh)
            self.assertRegex(ssh.splitlines()[0], r'\x1b\[[0-9;]*42m')
            self.switch('c')
            codex = self.until('CODEX-READABLE')
            self.assertNotIn('SSH-PRIVATE-SCREEN', codex)

    def test_native_background_codex_output_stays_on_its_own_screen(self):
        import signal
        pid = int((self.home / 'local.pid').read_text())
        self.switch('r')
        self.until('SSH-PRIVATE-SCREEN')
        os.kill(pid, signal.SIGUSR1)
        time.sleep(.1)
        self.assertNotIn('CODEX-BACKGROUND-UPDATE', self.capture())
        self.switch('c')
        result = self.until('CODEX-BACKGROUND-UPDATE')
        self.assertNotIn('SSH-PRIVATE-SCREEN', result)

    def test_native_wheel_scrollback_stays_pinned_and_returns_live(self):
        import signal
        self.tmux('send-keys', '-t', 'cx-test', '-l', 'history')
        self.tmux('send-keys', '-t', 'cx-test', 'Enter')
        self.until('CHAT-LINE-49')
        self.tmux('send-keys', '-t', 'cx-test', '-H', *[f'{byte:02x}' for byte in b'\x1b[<64;5;4M'])
        history = self.until('HISTORY +3')
        self.assertNotIn('CHAT-LINE-49', history)
        os.kill(int((self.home / 'local.pid').read_text()), signal.SIGUSR1)
        time.sleep(.1)
        self.assertNotIn('CODEX-BACKGROUND-UPDATE', self.capture())
        self.switch('b')
        live = self.until('CODEX-BACKGROUND-UPDATE')
        self.assertNotIn('HISTORY', live)
        self.assertNotIn('SSH-PRIVATE-SCREEN', live)

    def test_native_dim_text_and_shaded_background_survive_switches(self):
        self.tmux('send-keys', '-t', 'cx-test', '-l', 'history')
        self.tmux('send-keys', '-t', 'cx-test', 'Enter')
        self.until('CHAT-LINE-49')
        self.switch('r')
        self.until('SSH-PRIVATE-SCREEN')
        self.switch('c')
        result = self.until('CHAT-LINE-49')
        terminal = Pane(80, 24, lambda *args: None)
        terminal.feed(result.replace('\n', '\r\n').encode())
        row = next(y for y, line in enumerate(terminal.screen.display) if 'CHAT-LINE-49' in line)
        char = terminal.screen.buffer[row][0]
        self.assertTrue(char.dim)
        self.assertIn(char.fg, ('cyan', 'idx:6'))
        self.assertEqual(char.bg, 'idx:236')

    def test_native_resize_and_application_clear_preserve_bar(self):
        self.tmux('resize-window', '-t', 'cx-test', '-x', '60', '-y', '14')
        result = self.until('PTY-SIZE:13:60')
        header = re.sub(r'\x1b\[[0-9;]*m', '', result.splitlines()[0])
        self.assertEqual(len(header), 60)
        self.assertIn('CODEX', header)
        self.assertNotIn('SSH-PRIVATE-SCREEN', result)
        self.switch('r')
        self.until('SSH-PRIVATE-SCREEN')
        self.tmux('send-keys', '-t', 'cx-test', '-l', "printf '\\033[2J\\033[HSSH-CLEAR-SCREEN'")
        self.tmux('send-keys', '-t', 'cx-test', 'Enter')
        ssh = self.until('SSH-CLEAR-SCREEN', row=1)
        header = re.sub(r'\x1b\[[0-9;]*m', '', ssh.splitlines()[0])
        self.assertTrue(header.startswith(' SSH'))
        self.switch('c')
        self.assertNotIn('SSH-CLEAR-SCREEN', self.until('CODEX-READABLE'))


if __name__ == '__main__':
    os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')
    unittest.main()
