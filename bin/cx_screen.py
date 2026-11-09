"""Saved SSH/Codex screens and a reserved session bar; no host packages needed."""
import codecs
from collections import namedtuple
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
import pyte
from pyte import modes
from wcwidth import wcwidth, wcswidth


StyledChar = namedtuple('StyledChar', pyte.screens.Char._fields +
                       ('dim', 'hidden', 'underline_style', 'underline_color', 'overline'),
                       defaults=pyte.screens.Char.__new__.__defaults__ +
                       (False, False, 0, 'default', False))


class StyledScreen(pyte.HistoryScreen):
    """Keep SGR attributes pyte does not model, without changing vendor code."""
    @property
    def default_char(self):
        return StyledChar(**super().default_char._asdict())

    def reset(self):
        super().reset()
        self.cursor.attrs = self.default_char
        self.scroll_offset = 0
        self.history_added = 0

    def index(self):
        if self.cursor.y == (self.margins.bottom if self.margins else self.lines - 1):
            self.history_added += 1
            if self.scroll_offset:
                self.scroll_offset = min(self.history.size, self.scroll_offset + 1)
        super().index()

    def erase_in_display(self, how=0, *args, **kwargs):
        super().erase_in_display(how, *args, **kwargs)
        if how == 3:
            self.scroll_offset = 0

    def scroll_lines(self, count, up=True):
        """CSI S/T scroll the region without moving the application cursor."""
        cursor_y = self.cursor.y
        top, bottom = self.margins or (0, self.lines - 1)
        try:
            self.cursor.y = bottom if up else top
            for _ in range(min(max(1, count), bottom - top + 1)):
                if up:
                    self.index()
                else:
                    pyte.Screen.reverse_index(self)
        finally:
            self.cursor.y = cursor_y

    def select_graphic_rendition(self, *attrs):
        parameters = list(map(str, attrs)) or ['0']
        while parameters:
            parts = parameters.pop(0).split(':')
            code = int(parts[0] or '0')
            if code in (38, 48, 58):
                color = None
                values = parts[1:] if len(parts) > 1 else parameters
                try:
                    kind = int(values.pop(0))
                    if kind == 5:
                        value = int(values.pop(0))
                        if 0 <= value <= 255:
                            color = 'idx:' + str(value)
                    elif kind == 2:
                        if len(parts) > 1 and len(values) == 4:
                            values.pop(0)  # Optional color-space ID in colon form.
                        rgb = [int(values.pop(0)) for _ in range(3)]
                        if all(0 <= value <= 255 for value in rgb):
                            color = ''.join(f'{value:02x}' for value in rgb)
                except (ValueError, IndexError):
                    pass
                if color is not None:
                    name = {38: 'fg', 48: 'bg', 58: 'underline_color'}[code]
                    self.cursor.attrs = self.cursor.attrs._replace(**{name: color})
            elif code in (2, 8, 28, 53, 55, 59):
                change = {2: {'dim': True}, 8: {'hidden': True}, 28: {'hidden': False},
                          53: {'overline': True}, 55: {'overline': False},
                          59: {'underline_color': 'default'}}[code]
                self.cursor.attrs = self.cursor.attrs._replace(**change)
            elif code in (4, 21, 24):
                try:
                    style = int(parts[1]) if len(parts) > 1 else (2 if code == 21 else int(code == 4))
                except ValueError:
                    continue
                self.cursor.attrs = self.cursor.attrs._replace(underscore=style != 0,
                                                              underline_style=style)
            else:
                super().select_graphic_rendition(code)
                if code == 105:
                    self.cursor.attrs = self.cursor.attrs._replace(bg='brightmagenta')
                if code == 22:
                    self.cursor.attrs = self.cursor.attrs._replace(dim=False)


class Pane:
    """A virtual terminal with independent normal and alternate screens."""
    def __init__(self, columns, lines, reply):
        self.main = StyledScreen(columns, lines, history=2000)
        self.alternate = StyledScreen(columns, lines, history=2000)
        self.screen = self.main
        self.reply = reply
        self.saved = False
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.stream = pyte.Stream(self)
        self.control_buffer = ''

    def __getattr__(self, name):
        # Stream binds event handlers once; resolve the active screen on each
        # call so alternate-screen changes do not leave stale bound methods.
        def dispatch(*args, **kwargs):
            return getattr(self.screen, name)(*args, **kwargs)
        return dispatch

    def write_process_input(self, text):
        self.reply(text.encode())

    def report_device_status(self, mode=0, **kwargs):
        if mode == 5:
            self.reply(b'\x1b[0n')
        elif mode == 6:
            row, column = self.screen.cursor.y + 1, min(self.screen.cursor.x + 1, self.screen.columns)
            if modes.DECOM in self.screen.mode and self.screen.margins:
                row -= self.screen.margins.top
            prefix = '?' if kwargs.get('private') else ''
            self.reply(f'\033[{prefix}{row};{column}R'.encode())

    def report_device_attributes(self, *args, **kwargs):
        self.reply(b'\x1b[?6c')

    def set_mode(self, *values, **kwargs):
        if kwargs.get('private'):
            for value in values:
                if value in (47, 1047, 1049) and self.screen is self.main:
                    self.saved = value == 1049
                    if self.saved:
                        self.main.save_cursor()
                    self.alternate.reset()
                    self.alternate.cursor.attrs = self.main.cursor.attrs
                    self.screen = self.alternate
                elif value == 1048:
                    self.screen.save_cursor()
            values = tuple(value for value in values if value not in (47, 1047, 1048, 1049))
        if values:
            self.screen.set_mode(*values, **kwargs)

    def reset_mode(self, *values, **kwargs):
        if kwargs.get('private'):
            for value in values:
                if value in (47, 1047, 1049) and self.screen is self.alternate:
                    self.screen = self.main
                    if self.saved:
                        self.main.restore_cursor()
                    self.saved = False
                elif value == 1048:
                    self.screen.restore_cursor()
            values = tuple(value for value in values if value not in (47, 1047, 1048, 1049))
        if values:
            self.screen.reset_mode(*values, **kwargs)

    def resize(self, columns, lines):
        for screen in (self.main, self.alternate):
            if lines < screen.lines:
                # Discard blank space below the cursor first. pyte's default
                # top clipping would erase a short prompt when shrinking.
                shift = max(0, screen.cursor.y - lines + 1)
                if shift:
                    screen.history.top.extend(screen.buffer[y] for y in range(shift))
                    screen.history_added += shift
                    if screen.scroll_offset:
                        screen.scroll_offset = min(screen.history.size, screen.scroll_offset + shift)
                    for y in range(screen.lines - shift):
                        screen.buffer[y] = screen.buffer[y + shift]
                for y in list(screen.buffer):
                    if y >= lines:
                        del screen.buffer[y]
                screen.lines = lines
                screen.cursor.y = max(0, min(screen.cursor.y - shift, lines - 1))
            screen.resize(columns=columns, lines=lines)
            screen.cursor.x = min(screen.cursor.x, columns - 1)
            screen.set_margins()
            screen.dirty.update(range(lines))

    @staticmethod
    def clean_csi(packet):
        parameters, final = packet[2:-1], packet[-1]
        # Unsupported intermediates must be consumed, not partially parsed as
        # printable suffixes (for example "3m" from colon-form SGR).
        if not re.fullmatch(r'\??[0-9;]*', parameters):
            return ''
        if parameters.startswith('?') and final not in 'hlncJK':
            return ''
        return '\033[' + parameters + final

    def feed_stream(self, text):
        try:
            self.stream.feed(text)
        except (TypeError, ValueError, IndexError, StopIteration):
            self.stream = pyte.Stream(self)

    def feed(self, data):
        text = self.control_buffer + self.decoder.decode(data)
        self.control_buffer = ''
        while text:
            start = text.find('\033')
            if start < 0:
                self.feed_stream(text)
                break
            if start:
                self.feed_stream(text[:start])
                text = text[start:]
            if len(text) < 2:
                self.control_buffer = text
                break
            if text[1] == '[':
                end = next((i for i in range(2, len(text)) if '@' <= text[i] <= '~'), None)
                if end is None:
                    self.control_buffer = text[-8192:]
                    break
                packet, text = text[:end + 1], text[end + 1:]
                if packet[-1] == 'm' and re.fullmatch(r'[0-9;:]*', packet[2:-1]):
                    self.screen.select_graphic_rendition(*packet[2:-1].split(';'))
                    continue
                if packet[-1] in 'ST' and re.fullmatch(r'[0-9]*', packet[2:-1]):
                    self.screen.scroll_lines(int(packet[2:-1] or '1'), up=packet[-1] == 'S')
                    continue
                packet = self.clean_csi(packet)
                if packet:
                    self.feed_stream(packet)
            elif text[1] in (']', 'P', '_'):
                ends = [(text.find('\033\\', 2), 2)]
                if text[1] == ']':
                    ends.append((text.find('\007', 2), 1))
                ends = [(index, length) for index, length in ends if index >= 0]
                if not ends:
                    self.control_buffer = text[-8192:]
                    break
                end, length = min(ends)
                packet, text = text[:end + length], text[end + length:]
                if packet[1] == ']':
                    self.feed_stream(packet)
            else:
                self.feed_stream(text[:2])
                text = text[2:]


class SessionDisplay:
    COLORS = dict(zip(('black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'white'), range(30, 38)))
    COLORS.update({'bright' + name: value + 60 for name, value in list(COLORS.items())})

    def __init__(self, deliver):
        self.deliver = deliver
        self.columns, self.rows = 80, 24
        self.panes = {}
        self.active = None
        self.label = 'SSH'
        self.enabled = False
        self.last = None
        self.last_screen = None
        self.last_paint = 0
        self.message = ''
        self.message_until = 0
        self.painting = False
        self.mouse_scroll = True

    @property
    def lines(self):
        return max(1, self.rows - 1)

    def pane(self, owner):
        if owner not in self.panes:
            self.panes[owner] = Pane(self.columns, self.lines, lambda data: self.deliver(owner, data))
        return self.panes[owner]

    def feed(self, owner, data):
        self.pane(owner).feed(data)

    def scroll(self, owner, lines):
        screen = self.pane(owner).screen
        screen.scroll_offset = max(0, min(len(screen.history.top), screen.scroll_offset + lines))
        self.last = None
        self.paint(force=True)

    def follow(self, owner):
        if self.pane(owner).screen.scroll_offset:
            self.scroll(owner, -len(self.pane(owner).screen.history.top))

    def start(self, rows=24, columns=80):
        self.enabled = True
        self.resize(rows, columns)
        self.write(b'\x1b[?1049h\x1b[0m\x1b[r\x1b[?6l\x1b[2J\x1b[H')
        self.paint(force=True)

    def close(self):
        if self.enabled:
            self.write(b'\x1b[0m\x1b[r\x1b[?6l\x1b[?7h\x1b[?25h\x1b[?1049l')
            self.enabled = False

    def resize(self, rows, columns):
        self.rows, self.columns = max(1, rows or 24), max(1, columns or 80)
        for pane in self.panes.values():
            pane.resize(self.columns, self.lines)
        self.last = None

    def select(self, owner, label):
        changed = owner is not self.active
        self.active, self.label = owner, label
        if changed:
            self.message = ''
        self.last = None
        self.paint(force=True)

    def notice(self, message):
        self.message = ''.join(ch if ch.isprintable() else ' ' for ch in message)
        self.message_until = time.monotonic() + 4
        self.paint(force=True)

    @staticmethod
    def write(data):
        while data:
            count = os.write(1, data)
            data = data[count:]

    def header(self):
        hint = 'Ctrl-] c: CODEX' if self.label == 'SSH' else 'Ctrl-] r: SSH'
        text = f' {self.label}  |  {hint}'
        offset = self.pane(self.active).screen.scroll_offset
        if offset:
            text += f'  |  HISTORY +{offset}  Ctrl-] b: live'
        if self.message and time.monotonic() < self.message_until:
            text += '  |  ' + self.message
        elif not offset:
            text += '  |  Shift-drag: select' if self.mouse_scroll else '  |  Mouse: selection'
        result, width = '', 0
        for char in text:
            cells = wcwidth(char)
            if cells < 0:
                continue
            if width + cells > self.columns:
                break
            result += char
            width += cells
        return result + ' ' * (self.columns - width)

    @classmethod
    def style(cls, char):
        flags = [0]
        for attr, code in (('bold', 1), ('dim', 2), ('italics', 3), ('blink', 5),
                           ('reverse', 7), ('hidden', 8), ('strikethrough', 9), ('overline', 53)):
            if getattr(char, attr):
                flags.append(code)
        if char.underscore:
            flags.append('4:' + str(char.underline_style or 1))
        for color, foreground in ((char.fg, True), (char.bg, False)):
            if color in cls.COLORS:
                flags.append(cls.COLORS[color] + (0 if foreground else 10))
            elif color.startswith('idx:'):
                flags.extend([38 if foreground else 48, 5, int(color[4:])])
            elif re.fullmatch('[0-9a-fA-F]{6}', color):
                flags.extend([38 if foreground else 48, 2] + [int(color[i:i + 2], 16) for i in (0, 2, 4)])
            else:
                flags.append(39 if foreground else 49)
        color = char.underline_color
        if color.startswith('idx:'):
            flags.extend([58, 5, int(color[4:])])
        elif re.fullmatch('[0-9a-fA-F]{6}', color):
            flags.extend([58, 2] + [int(color[i:i + 2], 16) for i in (0, 2, 4)])
        else:
            flags.append(59)
        return '\033[' + ';'.join(map(str, flags)) + 'm'

    def row(self, screen, y, line=None):
        line = screen.buffer[y] if line is None else line
        result, previous, width = '', None, 0
        for x in range(self.columns):
            char = line[x]
            if not char.data:
                continue  # Second cell of a wide character.
            cells = max(0, wcswidth(char.data))
            if width + cells > self.columns:
                break
            style = self.style(char)
            if style != previous:
                result += style
                previous = style
            result += char.data
            width += cells
        if width < self.columns:
            result += '\033[0m' + ' ' * (self.columns - width)
        return result + '\033[0m'

    def paint(self, force=False):
        if not self.enabled or self.painting:
            return
        now = time.monotonic()
        if not force and now - self.last_paint < 1 / 30:
            return
        self.painting = True
        try:
            screen = self.pane(self.active).screen
            offset = min(screen.scroll_offset, len(screen.history.top))
            identity = (screen, offset, screen.history_added)
            header = self.header()
            color = 42 if self.label == 'SSH' else 44
            rows = [f'\033[0;1;97;{color}m' + header + '\033[0m']
            count = min(self.lines, self.rows - 1)
            if offset:
                history = list(screen.history.top) + [screen.buffer[y] for y in range(screen.lines)]
                end = len(history) - offset
                rows += [self.row(screen, y, line) for y, line in enumerate(history[end - count:end])]
            elif self.last is None or self.last_screen != identity:
                rows += [self.row(screen, y) for y in range(count)]
            else:
                rows += self.last[0][1:]
                for y in screen.dirty:
                    if 0 <= y < count:
                        rows[y + 1] = self.row(screen, y)
            output = []
            if self.last is None or self.last[0] != rows:
                # Applications never draw directly on the physical terminal.
                # They cannot clear, scroll into, or cover the reserved bar.
                output.append('\033[?25l\033[?7l\033[?6l\033[r')
                for y, row in enumerate(rows):
                    if self.last is None or y >= len(self.last[0]) or row != self.last[0][y]:
                        output.append(f'\033[{y + 1};1H' + row)
            cursor = (min(screen.cursor.x, self.columns - 1), screen.cursor.y + 1,
                      screen.cursor.hidden or bool(offset) or self.rows < 2)
            if output or self.last is None or self.last[1] != cursor:
                output.append(f'\033[{min(cursor[1] + 1, self.rows)};{cursor[0] + 1}H')
                output.append('\033[?25l' if cursor[2] else '\033[?25h')
                # Keep autowrap off for screen painting, not application PTYs.
                self.write(''.join(output).encode())
            self.last = (rows, cursor)
            self.last_screen = identity
            self.last_paint = now
            screen.dirty.clear()
        finally:
            self.painting = False
