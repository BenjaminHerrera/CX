#!/usr/bin/env python3
"""Local saved-screen supervisor; reuses terminal plumbing without starting SSH."""
import importlib.util
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('cx_bridge', Path(__file__).with_name('cx-ssh-bridge.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalBridge(module.Bridge):
    def __init__(self, *args):
        super().__init__(*args)
        self.focus = 'local'
        self.terminal.display.label = self.assistant_label
        self.terminal.display.header_hints[None] = 'Ctrl-] s: Sessions'

    def connect(self):
        self.focus = 'local'
        if os.environ.get('CX_SESSION_OPEN') == '1':
            self.menu.open()
        else:
            self.start_local()

    def start_local(self):
        if self.local:
            return
        self.menu.launched()
        self.local = self.spawn(self.launcher, dict(os.environ, CX_SESSION_SUPERVISED='1'))
        self.terminal.display.header_hints[self.local] = 'Ctrl-] s: Sessions'
        if not self.menu.opened:
            self.terminal.switch(self.local, self.assistant_label)
        self.resize()

    def activate(self):
        self.switch_focus('local')

    def switch_focus(self, focus):
        if focus == 'remote':
            self.notice('This is a local CX session. Ctrl-] s opens Sessions.')
            return
        super().switch_focus('local')


def main():
    if not (os.isatty(0) and os.isatty(1)):
        sys.exit('cx: the session menu requires an interactive terminal.')
    try:
        return LocalBridge('', '', sys.argv[1:]).run()
    except (OSError, ValueError) as exc:
        sys.exit('cx sessions: '+str(exc))


if __name__ == '__main__':
    sys.exit(main())
