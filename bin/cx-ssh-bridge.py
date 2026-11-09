#!/usr/bin/env python3
"""Host-only PTY supervisor. No third-party Python modules required."""
import base64
import errno
import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
import time
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import uuid
import tty
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cx_screen import SessionDisplay


class TerminalIO:
    """Route input and maintain separate virtual terminals for both PTYs."""
    # Physical mouse tracking belongs to the bridge. Only wheel events may
    # reach a child; Shift-drag keeps native terminal selection available.
    MOUSE_MODES = (9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016)
    MODES = (1, 1004, 2004, 9001) + MOUSE_MODES

    def __init__(self, deliver):
        self.deliver = deliver
        self.enabled = False
        self.mouse_scroll = True
        self.colors = {}
        self.color_queries = set()
        self.buffers = {}
        self.states = {}
        self.display = SessionDisplay(deliver)
        self.input = bytearray()
        self.input_since = 0
        self.pasting = False
        self.paste_owner = None
        self.paste_markers = True

    @staticmethod
    def packet_length(data, input_mode=False):
        if len(data) < 2:
            return None
        if input_mode and data.startswith(b'\x1b[M'):
            return 6 if len(data) >= 6 else None
        if data[1] == ord('['):
            for index in range(2, len(data)):
                if 0x40 <= data[index] <= 0x7e:
                    return index + 1
        elif data[1] in (ord(']'), ord('P'), ord('_')):
            end = data.find(b'\x1b\\', 2)
            bell = data.find(b'\x07', 2) if data[1] == ord(']') else -1
            if bell >= 0 and (end < 0 or bell < end):
                return bell + 1
            if end >= 0:
                return end + 2
        elif data[1] == ord('O'):
            return 3 if len(data) >= 3 else None
        else:
            return 2
        return None

    def state(self, owner):
        return self.states.setdefault(owner, {'modes': set(), 'mouse': set(), 'keys': [0], 'modify': 0, 'keypad': False, 'surrogate': None})

    def apply_mouse(self):
        if self.enabled:
            os.write(1, b'\x1b[?1000h\x1b[?1006h' if self.mouse_scroll else
                     b'\x1b[?1000l\x1b[?1006l')
        self.display.mouse_scroll = self.mouse_scroll

    def reset(self):
        if self.enabled:
            os.write(1, (''.join('\033[?' + str(mode) + 'l' for mode in self.MODES) +
                         '\033[=0u\033[>4;0m\033>').encode())

    def switch(self, owner, label='SSH'):
        self.display.select(owner, label)
        if not self.enabled:
            return
        self.reset()
        state = self.state(owner)
        sequence = ''.join('\033[?' + str(mode) + 'h' for mode in sorted(state['modes'])
                           if mode not in self.MOUSE_MODES)
        sequence += '\033[=' + str(state['keys'][-1]) + 'u'
        sequence += '\033[>4;' + str(state['modify']) + 'm'
        if state['keypad']:
            sequence += '\033='
        os.write(1, sequence.encode())
        self.apply_mouse()

    def start(self, rows=24, columns=80):
        self.enabled = True
        # Preserve the enclosing shell's kitty keyboard flags once. Child
        # push/pop operations are virtualized rather than sharing this stack.
        os.write(1, b'\x1b[>0u')
        self.reset()
        self.display.start(rows, columns)
        self.apply_mouse()
        # Cache theme colors once. Replies are consumed by the bridge, never
        # delivered as keystrokes to an authentication prompt or another PTY.
        self.color_queries = {'10', '11', '12'}
        os.write(1, b'\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\')

    def close(self):
        self.reset()
        if self.enabled:
            self.display.close()
            os.write(1, b'\x1b[<u')
            self.enabled = False

    def render(self, owner, data, visible=True):
        data = self.buffers.pop(owner, b'') + data
        while data:
            start = data.find(b'\x1b')
            if start < 0:
                if visible:
                    self.display.feed(owner, data)
                break
            if start:
                if visible:
                    self.display.feed(owner, data[:start])
                data = data[start:]
            length = self.packet_length(data)
            if length is None:
                if len(data) <= 8192:
                    self.buffers[owner] = data
                break
            packet, data = data[:length], data[length:]
            state = self.state(owner)
            modes = re.fullmatch(rb'\x1b\[\?([0-9;]+)([hl])', packet)
            keys = re.fullmatch(rb'\x1b\[([>=<])([0-9]*)(?:;([123]))?u', packet)
            modify = re.fullmatch(rb'\x1b\[>4;([012])m', packet)
            if modes:
                for mode in map(int, modes[1].split(b';')):
                    if mode in self.MODES:
                        if mode in self.MOUSE_MODES:
                            if modes[2] == b'h':
                                state['mouse'].add(mode)
                            else:
                                state['mouse'].discard(mode)
                        if modes[2] == b'h' and mode not in self.MOUSE_MODES:
                            state['modes'].add(mode)
                        else:
                            state['modes'].discard(mode)
            elif keys:
                operation, value = keys[1], int(keys[2] or (b'1' if keys[1] == b'<' else b'0'))
                stack = state['keys']
                if operation == b'>':
                    stack.append(value)
                elif operation == b'<':
                    del stack[max(1, len(stack) - value):]
                elif keys[3] == b'2':
                    stack[-1] |= value
                elif keys[3] == b'3':
                    stack[-1] &= ~value
                else:
                    stack[-1] = value
                # Do not let either child change the physical shared stack.
                packet = b'\x1b[=' + str(stack[-1]).encode() + b'u'
            elif modify:
                state['modify'] = int(modify[1])
            elif packet in (b'\x1b=', b'\x1b>'):
                state['keypad'] = packet == b'\x1b='
            kind = self.query_kind(packet)
            if kind:
                self.respond(owner, packet, kind)
            elif visible and not keys and not modify and not packet.startswith((b'\x1bP', b'\x1b_')):
                self.display.feed(owner, packet)

    def respond(self, owner, packet, kind):
        pane = self.display.pane(owner)
        if kind == 'cursor':
            pane.report_device_status(6, private=packet.startswith(b'\x1b[?'))
        elif kind == 'status':
            self.deliver(owner, b'\x1b[0n')
        elif kind == 'device:?':
            self.deliver(owner, b'\x1b[?6c')
        elif kind == 'device:>':
            self.deliver(owner, b'\x1b[>0;0;0c')
        elif kind == 'device:=':
            self.deliver(owner, b'\x1bP!|00000000\x1b\\')
        elif kind.startswith('mode:'):
            mode = int(kind.split(':')[1])
            known = mode in self.MODES or mode in (6, 7, 25, 47, 1047, 1048, 1049)
            enabled = mode in self.state(owner)['modes'] or mode << 5 in pane.screen.mode
            if mode in self.MOUSE_MODES:
                enabled = mode in self.state(owner)['mouse']
            if mode in (47,1047,1049):
                enabled = pane.screen is pane.alternate
            status = (1 if enabled else 2) if known else 0
            self.deliver(owner, f'\033[?{mode};{status}$y'.encode())
        elif kind.startswith('color:'):
            number = kind.split(':')[1]
            rgb = self.colors.get(number, '0000/0000/0000' if number == '11' else 'ffff/ffff/ffff')
            self.deliver(owner, f'\033]{number};rgb:{rgb}\033\\'.encode())
        elif kind == 'window':
            rows, columns = pane.screen.lines, pane.screen.columns
            reply = f'\033[8;{rows};{columns}t' if packet == b'\x1b[18t' else '\033[4;0;0t'
            self.deliver(owner, reply.encode())
        elif kind == 'dcs':
            if packet.startswith(b'\x1bP+q'):
                self.deliver(owner, b'\x1bP0+r\x1b\\')
            else:
                self.deliver(owner, b'\x1bP>|cx\x1b\\')
        # Do not advertise enhanced keyboard support from the virtual terminal:
        # legacy key input works across Linux/WSL hosts without translating an
        # entire keyboard protocol. Explicit app mode changes remain tracked.

    @staticmethod
    def query_kind(packet):
        if packet == b'\x1b[5n':
            return 'status'
        if re.fullmatch(rb'\x1b\[\??6n', packet):
            return 'cursor'
        if re.fullmatch(rb'\x1b\[[>=]?0?c', packet):
            return 'device:' + (chr(packet[2]) if packet[2] in b'>=' else '?')
        if packet == b'\x1b[?u':
            return 'keys'
        mode = re.fullmatch(rb'\x1b\[\?(\d+)\$p', packet)
        if mode:
            return 'mode:' + mode[1].decode()
        color = re.fullmatch(rb'\x1b\](10|11|12);\?(?:\x07|\x1b\\)', packet)
        if color:
            return 'color:' + color[1].decode()
        if packet in (b'\x1b[18t', b'\x1b[14t'):
            return 'window'
        if packet.startswith(b'\x1bP+q') or packet == b'\x1b[>q':
            return 'dcs'
        return None

    @staticmethod
    def reply_kind(packet):
        if re.fullmatch(rb'\x1b\[\??\d+;\d+R', packet):
            return 'cursor'
        if re.fullmatch(rb'\x1b\[[?>=][0-9;]*c', packet):
            return 'device:' + chr(packet[2])
        if re.fullmatch(rb'\x1b\[\?\d+u', packet):
            return 'keys'
        mode = re.fullmatch(rb'\x1b\[\?(\d+);\d+\$y', packet)
        if mode:
            return 'mode:' + mode[1].decode()
        color = re.match(rb'\x1b\](10|11|12);', packet)
        if color:
            return 'color:' + color[1].decode()
        if re.fullmatch(rb'\x1b\[[48];\d+;\d+t', packet):
            return 'window'
        if packet.startswith((b'\x1bP0+r', b'\x1bP1+r', b'\x1bP>|', b'\x1bP!|')):
            return 'dcs'
        return None

    def reply(self, packet):
        # Applications query their saved virtual terminal, not the physical
        # viewport. Late reports from an earlier session are never user input.
        color = re.fullmatch(rb'\x1b\](10|11|12);rgb:([0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4})(?:\x07|\x1b\\)', packet)
        if color and color[1].decode() in self.color_queries:
            number = color[1].decode()
            self.colors[number] = color[2].decode()
            self.color_queries.discard(number)
        return self.reply_kind(packet) is not None

    def read_input(self, data):
        if not self.input:
            self.input_since = time.monotonic()
        self.input.extend(data)
        while self.input:
            if self.pasting:
                marker = b'\x1b[201~'
                end = self.input.find(marker)
                if end == 0:
                    del self.input[:len(marker)]
                    yield marker
                elif end > 0:
                    packet = bytes(self.input[:end])
                    del self.input[:end]
                    yield packet
                else:
                    keep = 0
                    for size in range(1, min(len(marker), len(self.input) + 1)):
                        if self.input.endswith(marker[:size]):
                            keep = size
                    count = len(self.input) - keep
                    packet = bytes(self.input[:count])
                    del self.input[:count]
                    if packet:
                        yield packet
                    break
                continue
            if self.input[0] != 27:
                byte = self.input.pop(0)
                yield bytes([byte])
                continue
            length = self.packet_length(self.input, input_mode=True)
            if length is None:
                if len(self.input) > 8192:
                    self.input.clear()
                break
            packet = bytes(self.input[:length])
            del self.input[:length]
            yield packet

    def flush_input(self):
        # A standalone Escape must still reach the application. Partial CSI/OSC
        # reports stay buffered, so their tails cannot become password text.
        if not self.pasting and self.input == b'\x1b' and time.monotonic() - self.input_since >= .05:
            self.input.clear()
            return b'\x1b'
        return b''


class Bridge:
    def __init__(self, host, directory, launcher):
        self.host, self.directory, self.launcher = host, directory, launcher
        self.remote = self.local = None
        self.focus = 'remote'
        self.ready = False
        self.pending = None
        self.buffer = b''
        self.clients = {}
        self.escape = False
        self.resize_pending = False
        self.running = True
        self.result = 1
        self.mount_mode = os.environ.get('CX_SSH_MOUNT_REQUEST', '')
        self.mount_process = None
        self.mount_path = None
        self.mount_log = None
        self.terminal = TerminalIO(self.deliver_terminal)

    def deliver_terminal(self, owner, data):
        if owner is not None and (owner is self.remote or owner is self.local):
            while data:
                count = os.write(owner[0], data)
                data = data[count:]

    def switch_focus(self, focus):
        self.focus = focus
        self.terminal.switch(self.remote if focus == 'remote' else self.local,
                             'SSH' if focus == 'remote' else 'CODEX')

    def notice(self, message):
        if self.terminal.display.enabled:
            self.terminal.display.notice(message)
        else:
            os.write(1, ('\r\ncx SSH: ' + message + '\r\n').encode())

    def connection_help(self):
        # Match the command references in .bash_aliases (cxh, dh, sshfsh).
        color = os.environ.get('TERM') != 'dumb' and 'NO_COLOR' not in os.environ
        yellow = '\033[33m' if color else ''
        white = '\033[97m' if color else ''
        header = '\033[0;97;43m' if color else ''
        reset = '\033[0m' if color else ''
        lines = ['', f'{header} CX — SSH Session {reset}', '']

        def row(command, description):
            lines.append(f'  {yellow}{command:<24}{white} {description}{reset}')

        row('Host', self.host)
        row('Remote directory', self.directory or 'Remote login directory')
        if self.mount_mode:
            row('Container files', '/workspace/remote (' + self.mount_mode + ') via SSHFS')
        lines.extend(['', f'{header} Login / Terminal Controls {reset}', ''])
        row('Log in', 'Complete SSH authentication/MFA and reach a Bash prompt.')
        row('Ctrl-] c', 'Start Codex after login, or return to Codex.')
        row('Ctrl-] r', 'Open the remote terminal for authentication or interaction.')
        row('Ctrl-] q', 'Exit this cx SSH-mode session.')
        row('Ctrl-] b', 'Return to the live view after scrolling history.')
        row('Ctrl-] m', 'Toggle wheel scrolling; Shift-drag selects text when on.')
        row('Ctrl-] Ctrl-]', 'Send a literal Ctrl-] to the selected terminal.')
        lines.extend(['', f'{reset}'])
        self.terminal.render(self.remote, ('\r\n'.join(lines) + '\r\n').encode())

    def request_resize(self, *_):
        self.resize_pending = True

    def resize(self, *_):
        rows, columns, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
        rows, columns = rows or 24, columns or 80
        self.terminal.display.resize(rows, columns)
        size = struct.pack('HHHH', max(1, rows - 1), columns, 0, 0)
        for item in (self.remote, self.local):
            if item:
                try:
                    fcntl.ioctl(item[0], termios.TIOCSWINSZ, size)
                except OSError:
                    pass
        self.resize_pending = False
        self.terminal.display.paint(force=True)

    def spawn(self, args, env=None):
        master, slave = pty.openpty()
        if os.isatty(0):
            rows, columns, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
            size = struct.pack('HHHH', max(1, (rows or 24) - 1), columns or 80, 0, 0)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
        # Establish a controlling terminal for SSH authentication and Docker UI.
        def child_setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave,
                                   env=env, preexec_fn=child_setup, close_fds=True)
        os.close(slave)
        return master, process

    def connect(self):
        args = ['ssh', '-tt']
        if self.mount_mode:
            args += ['-o', 'ControlMaster=auto', '-o', 'ControlPath=' + self.control_path,
                     '-o', 'ControlPersist=no', '-o', 'ServerAliveInterval=15',
                     '-o', 'ServerAliveCountMax=3']
        self.remote = self.spawn(args + [self.host])
        self.ready = False
        self.switch_focus('remote')
        self.connection_help()
        self.resize()

    def send(self, client, **event):
        try:
            client.sendall((json.dumps(event) + '\n').encode())
        except OSError:
            self.clients.pop(client, None)
            client.close()

    def finish(self, status, error=None):
        if not self.pending:
            return
        client = self.pending['client']
        if client:
            self.send(client, type='done', status=status, error=error)
        self.pending = None
        self.buffer = b''

    def begin(self, command, client=None):
        token = uuid.uuid4().hex
        self.pending = {'client': client, 'token': token.encode(), 'started': False}
        # The marker is generated by printf, never present verbatim in echoed input.
        status_var, tty_var = '__cx_status_' + token, '__cx_tty_' + token
        payload = (tty_var + '=$(stty -g); stty -echo; ' +
                   "printf '\\036%s:start\\037' " + token + '; eval ' + shlex.quote(command) +
                   '; ' + status_var + '=$?; stty "$' + tty_var + '"; ' +
                   "printf '\\036%s:%s\\037' " + token + ' "$' + status_var + '"; ' +
                   'unset ' + status_var + ' ' + tty_var + '\n')
        os.write(self.remote[0], payload.encode())

    def activate(self):
        if not self.remote:
            self.notice('Connection closed. Press Ctrl-] r to reconnect; shell state was lost.')
            return
        if not self.ready:
            if self.pending:
                return
            command = 'test -n "${BASH_VERSION:-}"'
            if self.directory:
                command += ' && cd -- ' + shlex.quote(self.directory)
            self.begin(command)
        else:
            self.switch_focus('local')
            self.resize()
            self.notice('Codex terminal. Ctrl-] r opens the remote terminal.')

    def is_mounted(self, mountpoint):
        # Inspect the mount table without touching a possibly stalled FUSE server.
        with open('/proc/self/mountinfo') as mounts:
            for line in mounts:
                path = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
                if path == mountpoint:
                    return True
        return False

    def mount_files(self):
        if not self.mount_mode or self.mount_path:
            return
        if self.mount_mode not in ('ro', 'rw') or not self.directory.startswith('/'):
            raise ValueError('SSH mounting requires ro/rw and an absolute --remote-dir.')
        mountpoint = self.root + '/files'
        os.makedirs(mountpoint, mode=0o700, exist_ok=True)
        self.mount_log = tempfile.TemporaryFile()
        args = ['sshfs', '-f', self.host + ':' + self.directory, mountpoint,
                '-o', self.mount_mode, '-o', 'ControlMaster=no',
                '-o', 'ControlPath=' + self.control_path, '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
                '-o', 'allow_other,default_permissions,idmap=user',
                '-o', 'uid=' + str(os.getuid()), '-o', 'gid=' + str(os.getgid()),
                '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                '-o', 'dir_cache=no', '-o', 'attr_timeout=0']
        self.notice('Mounting the remote directory at /workspace/remote (' + self.mount_mode + ')...')
        self.mount_process = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                              stdout=subprocess.DEVNULL, stderr=self.mount_log,
                                              start_new_session=True)
        deadline = time.monotonic() + 30
        while self.mount_process.poll() is None and time.monotonic() < deadline:
            if self.is_mounted(mountpoint):
                self.mount_path = mountpoint
                return
            time.sleep(.1)
        self.mount_log.seek(0)
        error = self.mount_log.read(8192).decode(errors='replace').strip()
        raise OSError('SSHFS mount failed: ' + (error or 'mount did not become ready within 30 seconds') +
                      '. Check SFTP access, host SSHFS/FUSE, and user_allow_other in /etc/fuse.conf.')

    def cleanup_mount(self):
        # Never recursively remove a directory while a remote filesystem is mounted.
        mountpoint = self.root + '/files'
        safe = True
        if self.is_mounted(mountpoint):
            unmount = shutil.which('fusermount3') or shutil.which('fusermount')
            safe = False
            if unmount:
                for option in ('-u', '-uz'):
                    try:
                        result = subprocess.run([unmount, option, mountpoint],
                                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                stderr=subprocess.DEVNULL, timeout=10)
                        if result.returncode == 0:
                            safe = True
                            break
                    except (OSError, subprocess.TimeoutExpired):
                        pass
        if self.mount_process:
            try:
                os.killpg(self.mount_process.pid, signal.SIGTERM)
                self.mount_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.mount_process.pid, signal.SIGKILL)
                self.mount_process.wait()
            except ProcessLookupError:
                pass
        if self.mount_log:
            self.mount_log.close()
        if not safe:
            self.notice('Could not unmount ' + mountpoint + '; retaining ' + self.root +
                        '. Unmount it manually before deleting the directory.')
        return safe

    def start_local(self):
        if self.local:
            return
        self.mount_files()
        env = dict(os.environ, CX_SSH_BRIDGE_DIR=self.runtime, CX_SSH_HOST=self.host)
        if self.mount_path:
            env.update(CX_SSH_MOUNT_PATH=self.mount_path, CX_SSH_MOUNT_MODE=self.mount_mode)
        config_root = Path(os.environ.get('CX_CONFIG_DIR', str(Path(__file__).resolve().parents[1] / 'config')))
        instructions = tomllib.loads((config_root / 'config.toml').read_text()).get('developer_instructions', '')
        instructions += (' SSH mode is active. Run cx-remote status first. Use cx-remote exec with one quoted '
                         'command string for remote command execution. Without a filesystem mount use it for file reads and edits too. Local file tools see '
                         'the local workspace. The remote Bash shell preserves directory and environment state. '
                         'For authentication or interaction ask the user to press Ctrl-] r, complete it directly, '
                         'then Ctrl-] c. Never request authentication secrets in chat or command arguments. '
                         'After disconnect do not replay commands: outcomes may be unknown and shell state is lost.')
        instructions += (' Sessions start at /workspace, a container directory containing main/, cx-external/, and remote/. '
                         'The local project is /workspace/main; extra local directories are under /workspace/cx-external. '
                         'The remote directory is empty unless the session has a filesystem mount. '
                         'Read applicable project instructions under the selected project before working there.'
                         ' Individual --add-file mounts are also under /workspace/cx-external. Edit those files '
                         'in place; deleting or replacing their mountpoints by rename is unsupported.')
        instructions += ' SSH host alias: ' + json.dumps(self.host) + '. Initial remote directory: ' + json.dumps(self.directory or 'remote login directory') + '.'
        if self.mount_path:
            instructions += (' A live SSHFS view of that initial directory is mounted at /workspace/remote (' + self.mount_mode +
                             '). Use ordinary local file tools to browse/read /workspace/remote. ' +
                             ('Edits there write directly to the server. ' if self.mount_mode == 'rw' else
                              'The mount is read-only; use cx-remote exec for authorized remote edits. ') +
                             '/workspace/main is still the local project. Execute remote programs through cx-remote, '
                             'using server paths rather than /workspace/remote. The mount stays rooted at the initial directory '
                             'even if the shell changes directory or enters a compute allocation. If it fails after '
                             'a disconnect, restart cx to recreate it. This mount description overrides earlier '
                             'instructions that restrict local tools to the local workspace.')
        # Preserve system instructions even for installations retaining an older config.
        args = self.launcher[:2] + ['-c', 'developer_instructions=' + json.dumps(instructions, ensure_ascii=False)] + self.launcher[2:]
        self.local = self.spawn(args, env)
        self.terminal.switch(self.local, 'CODEX')
        self.resize()

    def output(self, data):
        if not self.pending:
            self.terminal.render(self.remote, data)
            return
        self.buffer += data
        token = self.pending['token']
        if not self.pending.get('started', True):
            marker = b'\x1e' + token + b':start\x1f'
            start = self.buffer.find(marker)
            if start < 0:
                count = max(0, len(self.buffer) - len(marker) + 1)
                self.terminal.render(self.remote, self.buffer[:count], visible=False)
                self.buffer = self.buffer[count:]
                return
            self.terminal.render(self.remote, self.buffer[:start], visible=False)
            self.terminal.display.feed(self.remote, b'\r\n')
            self.buffer = self.buffer[start + len(marker):]
            self.pending['started'] = True
        pattern = b'\x1e' + token + rb':([0-9]+)\x1f'
        match = re.search(pattern, self.buffer)
        # Stream immediately, retaining only a possible incomplete marker.
        prefix = b'\x1e' + token + b':'
        end = len(self.buffer)
        if match:
            end = match.start()
        else:
            start = self.buffer.rfind(b'\x1e')
            if start >= 0 and (prefix.startswith(self.buffer[start:]) or self.buffer[start:].startswith(prefix)):
                end = start
        chunk, self.buffer = self.buffer[:end], self.buffer[end:]
        client = self.pending['client']
        if chunk:
            self.terminal.render(self.remote, chunk)
            if self.focus != 'remote' and client:
                self.send(client, type='output', data=base64.b64encode(chunk).decode())
        if match:
            self.terminal.render(self.remote, self.buffer[len(match[0]):])
            status = int(match.group(1))
            bootstrap = client is None
            self.finish(status)
            if bootstrap:
                if status:
                    self.notice('Shell setup failed. Use a Bash shell and check --remote-dir, then Ctrl-] c.')
                else:
                    self.ready = True
                    self.switch_focus('local')
                    self.notice('Remote shell ready. Starting/resuming Codex. Ctrl-] r opens SSH.')
                    self.start_local()

    def request(self, client, request):
        if request.get('op') == 'status':
            self.send(client, type='status', host=self.host, connected=bool(self.remote),
                      ready=self.ready, busy=bool(self.pending), terminal=self.focus,
                      initial_directory=self.directory or None,
                      mount='/workspace/remote' if self.mount_path else None, mount_mode=self.mount_mode or None,
                      mount_connected=bool(self.mount_process and self.mount_process.poll() is None))
        elif request.get('op') == 'exec' and isinstance(request.get('command'), str):
            if not self.ready or not self.remote:
                self.send(client, type='done', status=255, error='Remote shell unavailable; ask the user to press Ctrl-] r and reconnect.')
            elif self.pending or self.focus == 'remote':
                self.send(client, type='done', status=125, error='Remote terminal is busy or controlled by the user.')
            else:
                self.begin(request['command'], client)
        else:
            self.send(client, type='done', status=2, error='Invalid request')

    def windows_key(self, packet, owner):
        if not re.fullmatch(rb'\x1b\[[0-9;]+_', packet):
            return None
        values = packet[2:-1].split(b';')
        if not 2 <= len(values) <= 6:
            return b''
        values += [b''] * (6 - len(values))
        vk, _, code, down, modifiers, repeat = [int(value or (b'1' if index == 5 else b'0'))
                                                for index, value in enumerate(values)]
        if down != 1 or vk in (16, 17, 18):
            return b''
        if not code:
            if modifiers & 12 and (65 <= vk <= 90 or vk == 32):
                code = vk & 31
            elif modifiers & 12 and vk == 221:
                code = 29
            else:
                key = {8: b'\x7f', 9: b'\t', 13: b'\r', 27: b'\x1b',
                       35: b'\x1b[F', 36: b'\x1b[H', 37: b'\x1b[D',
                       38: b'\x1b[A', 39: b'\x1b[C', 40: b'\x1b[B'}.get(vk)
                return key if key is not None else b''
        state = self.terminal.state(owner)
        if 0xd800 <= code <= 0xdbff:
            state['surrogate'] = code
            return b''
        if 0xdc00 <= code <= 0xdfff:
            high, state['surrogate'] = state['surrogate'], None
            if high is None:
                return b''
            code = 0x10000 + ((high - 0xd800) << 10) + code - 0xdc00
        else:
            state['surrogate'] = None
        if not 0 <= code <= 0x10ffff:
            return b''
        result = chr(code).encode() * max(1, min(repeat, 65535))
        return b'\x1b' + result if modifiers & 3 and not modifiers & 12 else result

    @staticmethod
    def legacy_key(packet):
        match = re.fullmatch(rb'\x1b\[(\d+)(?::[0-9:]+)?(?:;(\d+)(?::([123]))?)?u', packet)
        if not match:
            match = re.fullmatch(rb'\x1b\[27;(\d+);(\d+)~', packet)
            if not match:
                return None
            code, modifiers, event = int(match[2]), int(match[1]), 1
        else:
            code, modifiers, event = int(match[1]), int(match[2] or b'1'), int(match[3] or b'1')
        if event == 3:
            return b''
        modifiers -= 1
        if modifiers & ~7 or not 0 <= code <= 0x10ffff or 0xd800 <= code <= 0xdfff:
            return None
        if modifiers & 4 and 64 <= code <= 127:
            code &= 31
        data = chr(code).encode()
        if modifiers & 2:
            data = b'\x1b' + data
        return data

    def keyboard(self, data):
        for packet in self.terminal.read_input(data):
            owner = self.remote if self.focus == 'remote' else self.local
            if self.terminal.pasting:
                if packet != b'\x1b[201~' or self.terminal.paste_markers:
                    self.deliver_terminal(self.terminal.paste_owner, packet)
                if packet == b'\x1b[201~':
                    self.terminal.pasting = False
                continue
            if packet == b'\x1b[200~':
                self.terminal.display.follow(owner)
                self.terminal.pasting = True
                self.terminal.paste_owner = owner
                self.terminal.paste_markers = 2004 in self.terminal.state(owner)['modes']
                if self.terminal.paste_markers:
                    self.deliver_terminal(owner, packet)
                continue
            if self.terminal.reply(packet):
                continue
            if packet in (b'\x1b[I', b'\x1b[O'):
                if 1004 in self.terminal.state(owner)['modes']:
                    self.deliver_terminal(owner, packet)
                continue
            # Consume mouse packets locally; forward only wheel events to
            # applications which explicitly request mouse input.
            mouse = (packet.startswith(b'\x1b[M') or
                     re.fullmatch(rb'\x1b\[<?\d+;\d+;\d+[Mm]', packet))
            if mouse:
                self.wheel(owner, packet)
                continue
            legacy = self.windows_key(packet, owner)
            if legacy is None:
                legacy = self.legacy_key(packet)
            state = self.terminal.state(owner)
            enhanced = (9001 in state['modes'] if packet.endswith(b'_') else
                        bool(state['keys'][-1] or state['modify']))
            if legacy is not None and (self.focus == 'remote' or not enhanced or legacy == b'\x1d' or self.escape):
                self.keyboard_bytes(legacy)
            elif len(packet) > 1:
                self.terminal.display.follow(owner)
                self.deliver_terminal(owner, packet)
            else:
                self.keyboard_bytes(packet)

    def wheel(self, owner, packet):
        if not self.terminal.enabled or not self.terminal.mouse_scroll:
            return
        match = re.fullmatch(rb'\x1b\[(<?)(\d+);(\d+);(\d+)([Mm])', packet)
        if match:
            if match[5] != b'M':
                return
            button, column, row = map(int, (match[2], match[3], match[4]))
            if not match[1]:
                button -= 32  # urxvt encoding.
        elif packet.startswith(b'\x1b[M') and len(packet) == 6:
            button, column, row = (value - 32 for value in packet[3:])
        else:
            return
        direction = button & ~28  # Ignore Shift/Alt/Ctrl modifier bits.
        display = self.terminal.display
        if direction not in (64, 65) or not (1 <= column <= display.columns and 2 <= row <= display.rows):
            return
        requested = self.terminal.state(owner)['mouse']
        if requested.intersection((9, 1000, 1002, 1003)) and not display.pane(owner).screen.scroll_offset:
            row -= 1  # The reserved session bar is outside the child PTY.
            if 1006 in requested:
                output = f'\033[<{button};{column};{row}M'.encode()
            elif 1015 in requested:
                output = f'\033[{button + 32};{column};{row}M'.encode()
            elif max(button, column, row) <= 223:
                output = b'\x1b[M' + bytes(value + 32 for value in (button, column, row))
            else:
                return
            self.deliver_terminal(owner, output)
        else:
            display.scroll(owner, 3 if direction == 64 else -3)

    def keyboard_bytes(self, data):
        for byte in data:
            if self.escape:
                self.escape = False
                if byte == ord('r'):
                    self.switch_focus('remote')
                    if not self.remote:
                        self.connect()
                    self.notice('Remote terminal. Ctrl-] c returns to Codex after login/interaction.')
                elif byte == ord('c'):
                    self.activate()
                elif byte == ord('q'):
                    self.result = 130
                    self.running = False
                elif byte == ord('b'):
                    self.terminal.display.follow(self.remote if self.focus == 'remote' else self.local)
                elif byte == ord('m'):
                    self.terminal.mouse_scroll = not self.terminal.mouse_scroll
                    self.terminal.apply_mouse()
                    self.notice('Wheel scrolling on; Shift-drag selects text.' if self.terminal.mouse_scroll else
                                'Wheel scrolling off; drag selects text. Ctrl-] m enables scrolling.')
                elif byte == 29:
                    item = self.remote if self.focus == 'remote' else self.local
                    if item:
                        os.write(item[0], bytes([29]))
            elif byte == 29:
                self.escape = True
            else:
                item = self.remote if self.focus == 'remote' else self.local
                if item:
                    self.terminal.display.follow(item)
                    os.write(item[0], bytes([byte]))
                    if byte == 3 and self.focus == 'remote' and self.pending:
                        self.finish(130, 'User interrupted remote work; outcome may be unknown.')
                        self.ready = False

    def loop(self):
        while self.running:
            if self.resize_pending:
                self.resize()
            self.terminal.display.paint()
            readers = [0, self.server] + list(self.clients)
            readers += [item[0] for item in (self.remote, self.local) if item]
            readable, _, _ = select.select(readers, [], [], .05)
            pending_escape = self.terminal.flush_input() if 0 not in readable else b''
            if pending_escape:
                self.deliver_terminal(self.remote if self.focus == 'remote' else self.local, pending_escape)
            for source in readable:
                if source == 0:
                    data = os.read(0, 4096)
                    if not data:
                        return
                    self.keyboard(data)
                elif source is self.server:
                    client, _ = self.server.accept()
                    client.settimeout(.5)
                    self.clients[client] = b''
                elif source in self.clients:
                    try:
                        data = source.recv(65536)
                        if not data:
                            del self.clients[source]
                            source.close()
                            continue
                        self.clients[source] += data
                        if len(self.clients[source]) > 4 * 1024 * 1024:
                            raise ValueError('request too large')
                        if b'\n' in self.clients[source]:
                            line, self.clients[source] = self.clients[source].split(b'\n', 1)
                            self.request(source, json.loads(line))
                    except (OSError, ValueError, AttributeError):
                        self.clients.pop(source, None)
                        source.close()
                else:
                    item = self.remote if self.remote and source == self.remote[0] else self.local
                    try:
                        data = os.read(source, 65536)
                    except OSError as exc:
                        if exc.errno != errno.EIO:
                            raise
                        data = b''
                    if data:
                        if item is self.remote:
                            self.output(data)
                        else:
                            self.terminal.render(self.local, data)
                    else:
                        os.close(source)
                        if item is self.remote:
                            self.finish(255, 'SSH disconnected; command outcome may be unknown. Do not replay automatically.')
                            item[1].wait()
                            self.remote = None
                            self.ready = False
                            self.notice('SSH closed. Ctrl-] r reconnects with a new shell.')
                            if self.mount_path:
                                self.notice('The /workspace/remote mount may be disconnected. Restart cx to recreate it.')
                        else:
                            self.terminal.display.paint(force=True)
                            self.result = item[1].wait()
                            self.local = None
                            return

    def run(self):
        saved = termios.tcgetattr(0)
        old_resize = signal.signal(signal.SIGWINCH, self.request_resize)
        def stop(*_):
            self.running = False
        old_term = signal.signal(signal.SIGTERM, stop)
        old_int = signal.signal(signal.SIGINT, stop)
        try:
            self.root = os.path.realpath(tempfile.mkdtemp(prefix='cx-ssh-'))
            self.runtime = self.root + '/bridge'
            os.mkdir(self.runtime, 0o700)
            self.control_path = self.root + '/control'
            if ',' in self.root:
                raise ValueError('Temporary directory path contains a comma; set TMPDIR to a path without commas.')
            self.server = socket.socket(socket.AF_UNIX)
            self.server.bind(self.runtime + '/bridge.sock')
            os.chmod(self.runtime + '/bridge.sock', 0o600)
            self.server.listen(8)
            tty.setraw(0)
            rows, columns, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
            self.terminal.start(rows or 24, columns or 80)
            self.connect()
            self.loop()
        finally:
            try:
                self.terminal.close()
            except OSError:
                pass
            termios.tcsetattr(0, termios.TCSADRAIN, saved)
            signal.signal(signal.SIGWINCH, old_resize)
            signal.signal(signal.SIGTERM, old_term)
            signal.signal(signal.SIGINT, old_int)
            for client in list(self.clients):
                client.close()
            for item in (self.remote, self.local):
                if item:
                    try:
                        os.killpg(item[1].pid, signal.SIGTERM)
                        item[1].wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(item[1].pid, signal.SIGKILL)
                        item[1].wait()
                    except ProcessLookupError:
                        pass
                    os.close(item[0])
            if hasattr(self, 'server'):
                self.server.close()
            if hasattr(self, 'root') and self.cleanup_mount():
                shutil.rmtree(self.root)
        return self.result


def main():
    if not (os.isatty(0) and os.isatty(1)):
        sys.exit('cx: SSH mode requires an interactive terminal.')
    if len(sys.argv) < 5:
        sys.exit('cx: invalid SSH bridge arguments')
    host, directory = sys.argv[1:3]
    if not host or host.startswith('-'):
        sys.exit('cx: invalid SSH host')
    try:
        return Bridge(host, directory, sys.argv[3:]).run()
    except (OSError, ValueError) as exc:
        sys.exit('cx SSH: ' + str(exc))


if __name__ == '__main__':
    sys.exit(main())
