"""Saved-screen menu and asynchronous history-only worker for local/SSH CX."""
import codecs
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from cx_screen import wcwidth


def clean(text):
    return re.sub(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', ' ', str(text))[:240]


def fit(text, columns):
    result, width = '', 0
    for char in clean(text):
        cells = max(0, wcwidth(char))
        if width + cells > columns:
            break
        result += char
        width += cells
    return result


def cell_width(text):
    return sum(max(0, wcwidth(char)) for char in text)


def right_align(text, columns):
    text = fit(text, columns)
    return ' '*max(0, columns-cell_width(text))+text


def relative_time(value, now=None):
    try:
        seconds = max(0, (time.time() if now is None else now)-float(value))
        if seconds < 60:
            return 'just now'
        if seconds < 3600:
            return str(int(seconds//60))+'m ago'
        if seconds < 86400:
            return str(int(seconds//3600))+'h ago'
        if seconds < 604800:
            return str(int(seconds//86400))+'d ago'
        return datetime.fromtimestamp(float(value), timezone.utc).strftime('%b %d, %Y')
    except (ValueError, TypeError, OverflowError, OSError):
        return 'unknown time'


class SessionMenu:
    def __init__(self, bridge):
        self.bridge = bridge
        self.owner = object()
        self.opened = False
        self.rows, self.cursor, self.top = [], 0, 0
        self.start_if_empty = False
        self.all_rows = None
        self.query, self.cli_filter, self.status_filter, self.sort = '', 'All', 'Active', 'Name'
        self.control = None
        self.dense = True
        self.include_internal = False
        self.mode, self.text, self.message = 'list', '', ''
        self.active = None
        self.saved = {}
        self.live_row = None
        self.queued = None
        self.worker = None
        self.lease = None
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.pasting = False
        self.cx_escape = False
        self.data_home = Path(os.environ['CX_DATA_HOME'])
        for index, arg in enumerate(bridge.launcher[2:], 2):
            if arg in ('resume', '--resume', '-r') and index+1 < len(bridge.launcher) and re.fullmatch(r'[0-9a-fA-F-]{36}', bridge.launcher[index+1]):
                self.active = (os.environ.get('CX_AGENT', 'codex'), bridge.launcher[index+1].lower())

    def key(self, row):
        return row['agent'], row['id']

    def selected(self):
        return self.rows[self.cursor] if self.rows else None

    def replace(self, rows):
        self.all_rows = rows
        self.apply_filters()

    def apply_filters(self):
        key = self.key(self.selected()) if self.selected() else None
        terms = self.query.casefold().split()
        sources = {self.key(row): row for row in (self.all_rows if self.all_rows is not None else self.rows)}
        for saved in self.saved.values():
            row = saved['row']
            sources.setdefault(self.key(row), row)
        if self.live_row:
            sources.setdefault(self.key(self.live_row), self.live_row)
        rows = [row for row in sources.values()
                if (self.cli_filter == 'All' or row['agent'] == self.cli_filter.lower())
                and (self.status_filter == 'All' or bool(row.get('archived')) == (self.status_filter == 'Archived'))
                and (self.include_internal or not row.get('internal'))
                and all(term in ' '.join(str(row.get(field, '')) for field in ('name', 'agent', 'project', 'id')).casefold() for term in terms)]
        rows.sort(key=(lambda row: str(row['name']).casefold()) if self.sort == 'Name' else (lambda row: float(row.get('updated', 0))), reverse=self.sort == 'Updated')
        self.rows = rows
        self.cursor = next((i for i, row in enumerate(rows) if self.key(row) == key), min(self.cursor, max(0, len(rows)-1)))

    def change_option(self, direction):
        attribute, values = {'cli': ('cli_filter', ['All', 'Codex', 'Claude']),
                             'status': ('status_filter', ['Active', 'Archived', 'All']),
                             'sort': ('sort', ['Updated', 'Name'])}[self.control]
        setattr(self, attribute, values[(values.index(getattr(self, attribute))+direction) % len(values)])
        self.apply_filters()

    def activate_selected(self):
        row = self.selected()
        if not row or self.worker:
            return
        account = os.environ.get('CX_ACCOUNT')
        accounts = self.accounts(row['agent'])
        if self.key(row) in self.saved:
            self.choose(row, self.saved[self.key(row)]['account'])
        elif row['agent'] == os.environ.get('CX_AGENT') and account in accounts:
            self.choose(row, account)
        else:
            self.mode, self.target = 'account', dict(row)
            self.account_rows, self.account_index = accounts, 0

    def request(self, op, **values):
        if self.worker:
            return
        self.operation = op
        if op == 'list':
            values['includeInternal'] = self.include_internal
        try:
            self.worker = subprocess.Popen([self.bridge.launcher[0], 'sessions', 'menu-backend'],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.worker.stdin.write((json.dumps(dict(op=op, **values))+'\n').encode())
            self.worker.stdin.close()
        except OSError:
            if self.worker:
                try:
                    self.worker.terminate()
                except ProcessLookupError:
                    pass
                self.worker.stdout.close()
            self.worker = None
            self.message = 'History helper unavailable; outcome unknown. No automatic retry. The current terminals are retained.'
            return
        os.set_blocking(self.worker.stdout.fileno(), False)
        self.buffer = b''
        self.started = time.monotonic()
        self.message = 'Loading...' if op == 'list' else 'Saving... Do not retry if the outcome is unknown.'

    def poll(self):
        if not self.worker:
            return
        try:
            chunk = os.read(self.worker.stdout.fileno(), 65536)
            self.buffer += chunk
        except BlockingIOError:
            chunk = None
        if len(self.buffer) > 4*1024*1024 or time.monotonic()-self.started > 120:
            self.worker.terminate()
            self.message = 'History operation timed out/exceeded its limit; outcome unknown. No automatic retry.'
            self.worker.stdout.close()
            self.worker = None
            self.draw()
            return
        if self.worker.poll() is None or chunk:
            return
        process, self.worker = self.worker, None
        process.stdout.close()
        try:
            response = json.loads(self.buffer)
            if response.get('error') or process.returncode:
                raise ValueError(response.get('error', 'History operation failed.'))
            self.message = ''
            if self.operation == 'list':
                rows = response['rows']
                if not isinstance(rows, list):
                    raise ValueError('Invalid history list.')
                self.replace(rows)
                if self.start_if_empty:
                    self.start_if_empty = False
                    eligible = any(self.accounts(agent) for agent in {row['agent'] for row in self.rows})
                    if self.opened and not eligible and self.bridge.ready and not self.bridge.local:
                        self.close()
                        self.bridge.start_local()
                        return
            else:
                self.request('list')  # Discovery only; mutations are never replayed.
        except (ValueError, KeyError, TypeError):
            self.message = clean(response.get('error', 'History operation failed; refresh before another action.') if 'response' in locals() else 'Invalid history response; outcome unknown. No automatic retry.')
        self.draw()

    def open(self, start_if_empty=False):
        if self.opened:
            return
        self.previous = (self.bridge.terminal.display.active, self.bridge.terminal.display.label)
        self.opened, self.mode, self.pasting, self.control = True, 'list', False, None
        self.start_if_empty = start_if_empty
        self.cx_escape = False
        self.bridge.escape = False
        self.bridge.terminal.state(self.owner)['modes'].add(2004)
        self.bridge.terminal.switch(self.owner, 'Sessions')
        self.request('list')
        self.draw()

    def close(self):
        self.start_if_empty = False
        if not self.bridge.local and self.saved and not self.queued:
            # A failed new resume must not turn Esc into termination of the
            # preserved assistant. Return to its existing PTY instead.
            saved = next(reversed(self.saved.values()))
            self.choose(saved['row'], saved['account'])
            if self.opened:
                self.draw()
            return
        self.opened = False
        self.bridge.terminal.switch(*self.previous)
        if not self.bridge.local and not self.bridge.host and not self.queued:
            self.bridge.running, self.bridge.result = False, 130

    def move(self, delta):
        self.cursor = max(0, min(len(self.rows)-1, self.cursor+delta))

    def page_size(self):
        height = self.bridge.terminal.display.lines
        row_height = (2 if self.bridge.terminal.display.columns < 32 else 1) if self.dense else 3
        return max(1, (height-5-(6 if height >= 18 else 4))//row_height)

    def accounts(self, agent):
        root = self.data_home / 'profiles' / agent
        if root.is_symlink():
            return []
        return sorted(p.name for p in root.glob('*') if not p.is_symlink() and p.is_dir() and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', p.name))

    def choose(self, row, account):
        bridge = self.bridge
        if (self.key(row) == self.active or self.live_row and self.key(row) == self.key(self.live_row)) and bridge.local:
            self.close()
            return
        if not self.can_switch():
            self.message = 'Switch refused: remote work/authentication/manual focus is active. Return to assistant focus when ready.'
            return
        saved = self.saved.get(self.key(row))
        if saved and saved['account'] != account:
            self.message = 'Switch refused: this conversation is already running with account '+str(saved['account'])+'. Select its running session instead.'
            return
        self.queued = (dict(row), account)
        if bridge.local:
            self.park()
        self.close()
        self.handoff(0)

    def background_items(self):
        return [saved['item'] for saved in self.saved.values()]

    def park(self):
        row = self.live_row
        if row is None:
            row = next((dict(row) for row in (self.all_rows or self.rows) if self.key(row) == self.active), None)
        if row is None:
            # A new native session has no authoritative UUID yet. Give its live
            # PTY a private menu identity; never guess from recent history.
            row = dict(agent=os.environ.get('CX_AGENT', 'codex'),
                       id=self.active[1] if self.active else 'live-'+str(uuid.uuid4()),
                       name='Running '+os.environ.get('CX_AGENT', 'codex').title()+' session',
                       project=self.bridge.launcher[1], updated=time.time(), local_only=not self.active)
        self.saved[self.key(row)] = dict(row=row, item=self.bridge.local, lease=self.lease,
                                        launcher=self.bridge.launcher[:], account=os.environ.get('CX_ACCOUNT'),
                                        active=self.active, label=self.bridge.assistant_label)
        self.bridge.local, self.lease, self.live_row = None, None, None

    def background_exited(self, item, status):
        key = next(key for key, saved in self.saved.items() if saved['item'] is item)
        saved = self.saved.pop(key)
        if saved['lease']:
            saved['lease'].unlink(missing_ok=True)
        if saved['row'].get('local_only'):
            self.all_rows = [row for row in (self.all_rows or self.rows) if self.key(row) != key]
        self.message = 'Background assistant exited'+(' with an error' if status else '')+'. No command was replayed.'
        if self.opened:
            self.apply_filters()
            self.draw()

    def can_switch(self):
        bridge = self.bridge
        child = bridge.jobs.get(bridge.interactive.get('child')) if bridge.interactive else None
        ready_allocation = bridge.interactive and bridge.interactive.get('ready') and (not child or child['state'] == 'completed')
        return not ((bridge.pending and not ready_allocation) or (bridge.host and (not bridge.ready or bridge.focus == 'remote')))

    def handoff(self, status):
        self.release()
        if not self.queued:
            return False
        if not self.can_switch():
            self.queued = None
            self.bridge.notice('Switch cancelled because remote work became busy. Bridge and command IDs are retained; reopen Sessions when ready.')
            return True
        if status:
            self.queued = None
            self.bridge.notice('Assistant exited with an error; session switch cancelled. Open Ctrl-] s to retry explicitly.')
            return True
        row, account = self.queued
        self.queued = None
        args = self.bridge.launcher
        mounts, config = [], []
        config_flags = ({'-c', '--config', '--profile', '--enable', '--disable', '-C', '--cd'}
                        if row['agent'] == 'codex' else {'--settings', '--setting-sources', '--permission-mode'})
        same_agent = row['agent'] == os.environ.get('CX_AGENT')
        index = 2
        while index < len(args):
            if args[index] in ('--add-dir', '--add-file') and index+1 < len(args):
                mounts.extend(args[index:index+2]); index += 2
            else:
                if args[index].startswith(('--add-dir=', '--add-file=')):
                    mounts.append(args[index])
                if same_agent:
                    flag = args[index].split('=', 1)[0]
                    if flag in config_flags:
                        config.append(args[index])
                        if '=' not in args[index] and index+1 < len(args):
                            config.append(args[index+1])
                            index += 1
                index += 1
        agent = row['agent']
        self.bridge.launcher = args[:2] + ['--agent', agent, '--account', account] + mounts + config + (['resume', row['id']] if agent == 'codex' else ['--resume', row['id']])
        os.environ.update(CX_AGENT=agent, CX_ACCOUNT=account, CX_SELECTED_PROFILE=str(self.data_home/'profiles'/agent/account))
        self.bridge.assistant_label = agent.upper()+' / '+account
        self.active = self.key(row)
        saved = self.saved.pop(self.key(row), None)
        if saved:
            self.bridge.local, self.lease = saved['item'], saved['lease']
            self.bridge.launcher = saved['launcher']
            self.bridge.assistant_label = saved['label']
            self.active = saved['active']
            self.live_row = saved['row']
            self.bridge.focus = 'local'
            self.bridge.terminal.switch(self.bridge.local, self.bridge.assistant_label)
            self.bridge.resize()
            return True
        self.live_row = dict(row)
        # Completed assistant panes need not retain unbounded scrollback across
        # switches. The remote pane and its state are never discarded.
        terminal = self.bridge.terminal
        for owner in list(terminal.display.panes):
            if owner is not self.owner and owner is not self.bridge.help.owner and owner is not self.bridge.remote and owner not in self.background_items():
                terminal.display.panes.pop(owner, None)
                terminal.states.pop(owner, None)
                terminal.buffers.pop(owner, None)
        try:
            self.bridge.start_local()
        except (OSError, ValueError) as error:
            if not self.bridge.local:
                self.release()
                self.active = None
                self.live_row = None
            if not self.opened:
                self.open()
            self.message = 'Cannot start selected assistant: '+clean(error)+'. No automatic retry; remote state is retained.'
            self.draw()
            return True
        self.bridge.focus = 'local'
        if self.opened:
            self.previous = (self.bridge.local, self.bridge.assistant_label)
            self.draw()
        return True

    def launched(self):
        if os.environ.get('CX_AGENT') != 'claude':
            return
        root = self.data_home / 'history' / 'claude' / 'cx-live'
        for directory in (self.data_home/'history', root.parent, root):
            if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
                raise ValueError('Refusing unsafe writer lease storage.')
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lease = root / (str(uuid.uuid4())+'.json')
        with self.lease.open('x') as target:
            json.dump({'pid': os.getpid(), 'account': os.environ.get('CX_ACCOUNT')}, target)
        if (root.parent / 'cx-delete-lock').exists():
            self.release()
            raise ValueError('Claude history deletion is in progress; retry launch after it completes.')

    def release(self):
        if self.lease:
            self.lease.unlink(missing_ok=True)
            self.lease = None

    def shutdown(self):
        self.release()
        for saved in self.saved.values():
            if saved['lease']:
                saved['lease'].unlink(missing_ok=True)
        if self.worker:
            self.worker.terminate()
            self.worker.stdout.close()
            self.worker = None

    def handle(self, packet):
        if packet == b'\x1b[200~':
            self.pasting = True
            return
        if packet == b'\x1b[201~':
            self.pasting = False
            return
        if self.pasting:
            if self.mode in ('rename', 'search') and len(packet) == 1 and packet[0] >= 32:
                decoded = self.decoder.decode(packet)
                if self.mode == 'rename':
                    self.text = (self.text + decoded)[:200]
                else:
                    self.query = clean(self.query + decoded)[:200]
                    self.apply_filters()
            self.draw()
            return
        legacy = self.bridge.windows_key(packet, self.owner)
        if legacy is None:
            legacy = self.bridge.legacy_key(packet)
        packet = legacy if legacy is not None else packet
        if self.cx_escape:
            self.cx_escape = False
            if packet == b'q':
                self.bridge.running = False
            elif packet == b'?':
                self.bridge.help.open()
            return
        if packet == b'\x1d':
            self.cx_escape = True
            return
        if self.mode in ('list', 'search'):
            if re.fullmatch(rb'\x1b\[<6[45];\d+;\d+M', packet):
                self.move(-3 if packet.startswith(b'\x1b[<64;') else 3)
                self.draw()
                return
            if packet in (b'\x1b[A', b'\x1bOA', b'\x1b[B', b'\x1bOB', b'\x1b[5~', b'\x1b[6~'):
                self.control = None
                delta = -1 if packet in (b'\x1b[A', b'\x1bOA') else 1
                if packet in (b'\x1b[5~', b'\x1b[6~'):
                    delta = self.page_size() * (-1 if packet == b'\x1b[5~' else 1)
                self.move(delta)
                self.draw()
                return
            if packet == b'\t':
                self.mode = 'list'
                controls = [None, 'cli', 'status', 'sort']
                self.control = controls[(controls.index(self.control)+1) % len(controls)]
                self.draw()
                return
            if self.control and packet in (b'\x1b[D', b'\x1bOD', b'\x1b[C', b'\x1bOC'):
                self.change_option(-1 if packet in (b'\x1b[D', b'\x1bOD') else 1)
                self.draw()
                return
            if packet == b'\x0f':
                self.dense = not self.dense
                self.draw()
                return
            if packet in (b'\x1bOQ', b'\x1b[12~') and not self.worker:
                self.include_internal = not self.include_internal
                self.apply_filters()
                self.request('list')
                self.draw()
                return
            if packet == b'/' and self.mode == 'list':
                self.mode, self.control = 'search', None
                self.decoder.reset()
                self.draw()
                return
        row = self.selected()
        if packet in (b'\x1b', b'\x03') or (self.mode == 'list' and packet == b'q'):
            if self.mode != 'list':
                self.mode = 'list'
            else:
                self.queued = None
                self.close()
                return
        elif self.mode == 'search':
            if packet in (b'\r', b'\n'):
                self.mode = 'list'
                self.activate_selected()
            elif packet in (b'\x7f', b'\x08'):
                self.query = self.query[:-1]
            elif packet == b'\x15':
                self.query = ''
            elif len(packet) == 1 and packet[0] >= 32:
                self.query = clean(self.query + self.decoder.decode(packet))[:200]
            self.apply_filters()
        elif self.mode == 'rename':
            if packet in (b'\r', b'\n'):
                self.request('rename', agent=self.target['agent'], id=self.target['id'], value=self.text)
                self.mode = 'list'
            elif packet in (b'\x7f', b'\x08'):
                self.text = self.text[:-1]
            elif packet == b'\x15':
                self.text = ''
            elif len(packet) == 1 and packet[0] >= 32:
                self.text = (self.text + self.decoder.decode(packet))[:200]
        elif self.mode == 'delete':
            if packet == b'y':
                self.request('remove', agent=self.target['agent'], id=self.target['id'])
                self.mode = 'list'
            elif packet in (b'n', b'q'):
                self.mode = 'list'
        elif self.mode == 'account':
            if packet in (b'\x1b[A', b'\x1bOA'):
                self.account_index = max(0, self.account_index-1)
            elif packet in (b'\x1b[B', b'\x1bOB'):
                self.account_index = min(len(self.account_rows)-1, self.account_index+1)
            elif packet in (b'\r', b'\n') and self.account_rows:
                self.choose(self.target, self.account_rows[self.account_index])
        elif not self.worker and packet == b'f':
            self.request('list')
        elif not self.worker and row:
            if packet == b'r':
                if row.get('local_only'):
                    self.message = 'This live assistant has no known native ID. Rename it using the native CLI.'
                    self.draw()
                    return
                self.decoder.reset()
                self.mode, self.text, self.target = 'rename', row['name'], dict(row)
            elif packet in (b'd', b'\x1b[3~'):
                if self.key(row) == self.active or self.key(row) in self.saved or row.get('local_only'):
                    self.message = 'Exit the running assistant before deleting this conversation.'
                else:
                    self.mode, self.target = 'delete', dict(row)
            elif packet in (b'\r', b'\n'):
                self.activate_selected()
        self.draw()

    def draw(self):
        if not self.opened:
            return
        display = self.bridge.terminal.display
        height, width = display.lines, display.columns
        page = self.page_size()
        self.top = min(self.top, self.cursor)
        if self.cursor >= self.top+page:
            self.top = self.cursor-page+1
        dim = lambda text: '\033[2m'+fit(text, width)+'\033[0m'
        title = ' Resume a previous session'
        agent, _, account = self.bridge.assistant_label.partition(' / ')
        context = dim(' Assistant: '+agent.title()+'    Account: '+(account or '—'))
        controls = []
        for key, label, value in (('cli', 'CLI', self.cli_filter), ('status', 'Status', self.status_filter), ('sort', 'Sort', self.sort)):
            if width < 30 and key != (self.control or 'cli'):
                continue
            text = f'{label}: {value}' if width >= 60 else value
            text = fit(text, max(0, width-1))
            controls.append(('\033[4;36m'+text+'\033[0m') if self.control == key else text)
        query = ' Search: '+self.query+('▏' if self.mode == 'search' else '') if self.query or self.mode == 'search' else ' / Type to search by name, project or ID'
        lines = ['\033[1m'+fit(title, width)+'\033[0m', context, '', ' '+ '    '.join(controls),
                 ('\033[36m'+fit(query, width)+'\033[0m') if self.mode == 'search' else dim(query), '']
        if height < 18:
            lines = [lines[0], lines[1], lines[3], lines[4]]
        now = time.time()
        def metadata_text(row):
            updated = relative_time(row['updated'], now=now)
            if width < 32:
                updated = updated.replace('just now', 'now').replace(' ago', '').split(',')[0]
            archived = ' · archived' if row.get('archived') else ''
            return f"{row['agent']} · {updated}{archived}"
        # Size against the filtered list, not only the current page, so the
        # divider stays stable while scrolling. Reserve at least half for names.
        metadata_width = min(width//2, max((cell_width(metadata_text(row)) for row in self.rows), default=0))
        for index, row in enumerate(self.rows[self.top:self.top+page], self.top):
            chosen = index == self.cursor
            cursor = '›' if chosen else ' '
            active = ' *' if self.key(row) == self.active else ''
            if self.live_row and self.key(row) == self.key(self.live_row):
                active = ' *'
            tag = ' [internal]' if row.get('internal') else ''
            if self.key(row) in self.saved:
                tag += ' [running]'
            metadata = metadata_text(row)
            marker = active+tag
            prefix = f' {cursor} '
            color = '135;206;250' if row['agent'] == 'codex' else '217;119;87'
            def paint(text, faint=False):
                return ('\033[38;2;'+color+'m'+('\033[1m' if chosen else '')+
                        ('\033[2m' if faint else '')+text+'\033[0m')
            if width >= 32:
                left_width = max(0, width-metadata_width-3)
                marker = fit(marker, max(0, left_width-cell_width(prefix)))
                name = prefix+fit(row['name'], max(0, left_width-cell_width(prefix+marker)))+marker
                name += ' '*max(0, left_width-cell_width(name))+' │ '+right_align(metadata, metadata_width)
                lines.append(paint(name))
            else:
                # Stack the columns on small terminals instead of letting a
                # long title consume or masquerade as the metadata column.
                marker = fit(marker, max(0, width-cell_width(prefix)))
                name = prefix+fit(row['name'], max(0, width-cell_width(prefix+marker)))+marker
                lines += [paint(name), paint(right_align(metadata, width), faint=True)]
            if not self.dense:
                lines += ([paint(fit('    '+row['project'], width), faint=True), ''] if width >= 32 else [''])
        if not self.rows:
            lines.append(dim(' No matching sessions.' if self.query or self.all_rows else ' No saved sessions yet.'))
        selected = self.selected()
        total = len(self.rows)
        position = f' {self.cursor+1 if total else 0} / {total} '
        separator = '─'*max(0, width-len(position))+position
        identity = f" {selected['agent']} · {selected['id']}" if selected else ''
        if selected and self.key(selected) == self.active:
            identity += ' · active'
        if self.mode == 'rename':
            lines = ['\033[1m Rename session\033[0m', '', dim(' '+self.target['agent']+' · '+self.target['id']), '', fit(' Name: '+self.text+'▏', width)]
            status = ' Enter save · Esc cancel · Ctrl-U clear'
        elif self.mode == 'delete':
            lines = ['\033[1m Delete session?\033[0m', '', fit(' '+self.target['name'], width), '',
                     fit(' CLI: '+self.target['agent'], width), fit(' '+self.target['id'], width)]
            status = ' This cannot be undone.'
            identity = ' Shared by ALL accounts of this CLI.'
        elif self.mode == 'account':
            lines = ['\033[1m Choose an account\033[0m', '', fit(' '+self.target['name'], width), '']
            lines += [fit(('  › ' if i == self.account_index else '    ')+name, width) for i, name in enumerate(self.account_rows)]
            status = ' ↑/↓ choose · Enter continue · Esc cancel' if self.account_rows else ' No configured account for this CLI. Esc cancels.'
        elif self.mode == 'search':
            status = self.message or ' Type to filter · ↑/↓ browse · Enter resume · Esc finish search · Ctrl-U clear'
        else:
            status = self.message or ((' * active session' if self.active else ' Active: native/new session')+
                                      (' · Internal threads shown' if self.include_internal else ' · Internal threads hidden'))
        # Reserve the bottom for position, exact selected identity and two short
        # action lines. The list never scrolls through the header or footer.
        body_height = max(0, height-5)
        lines = lines[:body_height]+['']*max(0, body_height-len(lines))
        if self.mode in ('rename', 'delete', 'account'):
            hints = ' y confirm · n/Esc cancel' if self.mode == 'delete' else status
            secondary = ''
        else:
            hints = ' Enter resume · / search · r rename · d delete · Esc/q close'
            secondary = ' ↑↓/PgUp/PgDn browse · Tab/←→ filters · ^O dense · F2 internal · f refresh'
            if width < 80:
                secondary = ' ↑↓ browse · Tab/←→ filters · ^O dense · F2 internal'
        lines += [dim(separator), dim(identity), fit(status, width), dim(hints), dim(secondary)]
        data = '\033[?25l\033[2J\033[H'+'\r\n'.join(lines[:height])
        display.feed(self.owner, data.encode())
        display.paint(force=True)
