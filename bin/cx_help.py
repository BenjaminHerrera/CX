"""Read-only shortcut overlay shared by local, SSH and Sessions views."""
import re
import textwrap

from cx_sessions import fit, cell_width


class HelpMenu:
    def __init__(self, bridge):
        self.bridge = bridge
        self.owner = object()
        self.opened = self.escape = self.pasting = False
        self.top = 0
        self.message = ''
        self.new_notice = False

    def open(self):
        if self.opened:
            return
        display = self.bridge.terminal.display
        self.previous = (display.active, display.label)
        self.previous_notice = (display.message, display.message_until)
        self.opened, self.escape, self.pasting, self.top = True, False, False, 0
        self.message = display.status()
        self.new_notice = False
        self.bridge.escape = False
        if self.bridge.menu:
            self.bridge.menu.cx_escape = False
        display.header_styles[self.owner] = '0;30;43'
        self.bridge.terminal.state(self.owner)['modes'].add(2004)
        self.bridge.terminal.switch(self.owner, self.previous[1])
        self.draw()

    def close(self):
        self.opened = False
        self.escape = False
        self.bridge.terminal.switch(*self.previous)
        display = self.bridge.terminal.display
        display.message, display.message_until = self.previous_notice
        if self.new_notice:
            display.notice(self.message)
        display.paint(force=True)

    def retain(self):
        # Authentication/readiness and native exits may update the underlying
        # view while help is open. Keep help visible, but restore the new view
        # rather than a dead assistant when Esc is pressed.
        display = self.bridge.terminal.display
        if self.opened and display.active is not self.owner:
            self.previous = (display.active, display.label)
            self.previous_notice = (display.message, display.message_until)
            self.bridge.terminal.switch(self.owner, self.previous[1])
            self.draw()

    def entries(self):
        bridge = self.bridge
        in_sessions = bridge.menu and self.previous[0] is bridge.menu.owner
        remote = 'Unavailable in local mode.' if not bridge.host else 'After closing help, open SSH for user-owned login/MFA or interaction.'
        yield 'Ctrl-] ?', 'Open Help Menu. Press Ctrl-], release it, then press ?. Other prefixed shortcuts use the same sequence.'
        yield 'Esc', 'Close help and restore the previous screen, draft, focus and menu state.'
        yield 'Ctrl-] s', ('Open Sessions (managed interactive accounts).' if bridge.menu else 'Unavailable in legacy mode; use a managed account for Sessions.')
        yield 'Ctrl-] c', ('Unavailable in local mode; the assistant is already the local view.' if not bridge.host else 'After closing help, start/return to the assistant. Complete SSH authentication first.')
        yield 'Ctrl-] r', remote
        yield 'Ctrl-] q', 'Exit CX and stop all its saved assistants. Also works from help and Sessions.'
        yield 'Ctrl-] b', 'After closing help, return the current terminal to its live view from scrollback.'
        yield 'Ctrl-] m', 'After closing help, toggle wheel capture. Currently '+('on.' if bridge.terminal.mouse_scroll else 'off.')
        yield 'Shift-drag', 'Select text with the terminal while wheel capture is on. When off, ordinary drag selects text.'
        yield 'Ctrl-] Ctrl-]', 'After closing help, send a literal Ctrl-] to the selected assistant/SSH terminal. Unavailable as native input in Sessions.'
        yield 'Up/Down, PgUp/PgDn, wheel', 'Up/Down, Page Up/Page Down or mouse wheel scroll this reference. Repeating Ctrl-] ? keeps one help view.'
        if in_sessions:
            yield 'Up/Down, PgUp/PgDn', 'Move the highlighted session; the mouse wheel also moves selection.'
            yield 'Enter', 'Switch immediately when allowed, preserving the old assistant as a saved running session. In account selection, choose an account.'
            yield '/', 'Search names, projects, CLI names or IDs. While searching, ordinary letters edit the query.'
            yield 'Tab, Left/Right', 'Focus CLI/status/sort controls, then change their values.'
            yield 'Ctrl-O', 'Toggle compact/comfortable rows.'
            yield 'F2', 'Show/hide internal Codex reviewer/subagent sessions.'
            yield 'r', 'Rename the selected session. Enter saves; Esc cancels; Ctrl-U clears the name; Backspace edits.'
            yield 'd or Delete', 'Ask to delete the selected conversation. y confirms; n or Esc cancels. Running conversations cannot be deleted.'
            yield 'f', 'Refresh the history list; mutations are never automatically retried.'
            yield 'Esc or q', 'Close Sessions from the list. Esc cancels a modal; in search, Esc finishes editing. Ctrl-U clears search text.'

    def draw(self):
        if not self.opened:
            return
        display = self.bridge.terminal.display
        width, height = display.columns, display.lines
        yellow, bright, badge, reset = '\033[33m', '\033[93m', '\033[30;43m', '\033[0m'
        lines = []
        def section(title):
            lines.extend([yellow+fit('─'*width, width)+reset,
                          bright+fit(title, width)+reset, ''])
        section('Help Menu')
        entries = list(self.entries())
        key_width = max(cell_width(key) for key, _ in entries)
        for key, description in entries:
            # Like ah: black-on-yellow key badges, yellow descriptions and
            # yellow section rules. Wide terminals use aligned cheat-sheet rows.
            if width >= 60:
                descriptions = textwrap.wrap(description, max(1, width-key_width-4)) or ['']
                lines.append(badge+' '+key+' '+reset+' '*(key_width-cell_width(key)+2)+bright+descriptions[0]+reset)
                lines += [' '*(key_width+4)+bright+line+reset for line in descriptions[1:]]
            else:
                lines.append(badge+' '+fit(key, max(0, width-2))+' '+reset)
                lines += [bright+fit('  '+line, width)+reset for line in textwrap.wrap(description, max(1, width-2))]
            lines.append('')
        page = max(1, height-1)
        self.limit = max(0, len(lines)-page)
        self.top = max(0, min(self.top, self.limit))
        visible = lines[self.top:self.top+page]
        visible += ['']*max(0, page-len(visible))
        visible += [yellow+fit(' Esc close · arrows/Page keys scroll', width)+reset]
        display.feed(self.owner, ('\033[?25l\033[2J\033[H'+'\r\n'.join(visible[:height])).encode())
        display.paint(force=True)

    def handle(self, packet):
        if packet == b'\x1b[200~':
            self.pasting = True
            return
        if packet == b'\x1b[201~':
            self.pasting = False
            return
        if self.pasting:
            return
        legacy = self.bridge.windows_key(packet, self.owner)
        if legacy is None:
            legacy = self.bridge.legacy_key(packet)
        packet = legacy if legacy is not None else packet
        if packet == b'\x1b':
            self.close()
            return
        if self.escape:
            self.escape = False
            if packet == b'q':
                self.bridge.result, self.bridge.running = 130, False
            return
        if packet == b'\x1d':
            self.escape = True
        elif packet in (b'\x1b[A', b'\x1bOA', b'\x1b[B', b'\x1bOB', b'\x1b[5~', b'\x1b[6~'):
            delta = max(1, self.bridge.terminal.display.lines-2) if packet in (b'\x1b[5~', b'\x1b[6~') else 1
            self.top += -delta if packet in (b'\x1b[A', b'\x1bOA', b'\x1b[5~') else delta
        elif re.fullmatch(rb'\x1b\[<6[45];\d+;\d+M', packet):
            self.top += -3 if packet.startswith(b'\x1b[<64;') else 3
        self.draw()
