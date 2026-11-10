#!/usr/bin/env python3
"""Configure a private shared directory and startup hook for one SSH host."""
import base64
import fcntl
import json
import os
from pathlib import Path
import posixpath
import re
import shlex
import subprocess
import sys
import tempfile

CONFIG_BASE = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
CONFIG = Path(os.environ.get('CX_SLURM_CONFIG') or str(Path(CONFIG_BASE) / 'cx' / 'slurm-servers.json'))
REMOTE = r'''set -Eeuo pipefail
root=$1
hook_data=$2
old_hashes=$3
case "$root" in /*) ;; *) echo 'Shared directory must be absolute.' >&2; exit 2;; esac
[[ "$root" != / && "$root" != *$'\n'* && "$root" != *$'\r'* ]] || { echo 'Invalid shared directory.' >&2; exit 2; }
umask 077
mkdir -p -- "$HOME/.config/cx" "$HOME/.bashrc.d"
hook="$HOME/.bashrc.d/cx-interactive.sh"
roots="$HOME/.config/cx/slurm-roots"
bashrc="$HOME/.bashrc"
[[ ! -L "$hook" && ! -L "$roots" ]] || { echo 'Refusing to replace symlinked cx hook or roots file.' >&2; exit 1; }
tmp=$(mktemp "$HOME/.bashrc.d/.cx-hook.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
printf '%s' "$hook_data" | base64 -d > "$tmp"
if [[ -e "$hook" ]]; then
  existing=$(sha256sum -- "$hook"); existing=${existing%% *}
  new=$(sha256sum -- "$tmp"); new=${new%% *}
  [[ ":$old_hashes:" == *":$existing:"* || "$existing" == "$new" ]] || { echo 'Existing cx-interactive.sh is not a recognized cx hook; review it before setup.' >&2; exit 1; }
fi
if [[ -e "$roots" && ! -f "$roots" ]]; then echo 'Invalid remote roots file.' >&2; exit 1; fi
if [[ -e "$bashrc" && ! -f "$bashrc" ]]; then echo 'Invalid remote .bashrc.' >&2; exit 1; fi
if [[ -L "$root" ]]; then echo 'Shared directory must not be a symlink.' >&2; exit 1; fi
mkdir -p -- "$root"
[[ -d "$root" && -O "$root" ]] || { echo 'Shared directory must be owned by this user.' >&2; exit 1; }
if [[ -L "$root/interactive" ]]; then echo 'Interactive directory must not be a symlink.' >&2; exit 1; fi
mkdir -p -- "$root/interactive"
[[ -d "$root/interactive" && -O "$root/interactive" ]] || { echo 'Interactive directory must be owned by this user.' >&2; exit 1; }
mode=$(stat -c %a -- "$root/interactive")
(( (8#$mode & 077) == 0 )) || { echo 'Interactive directory must be private (no group/other access).' >&2; exit 1; }
if [[ -e "$bashrc" ]] && ! grep -Fq '# cx slurm hook v1' "$bashrc"; then
  backup=$(mktemp "$HOME/.bashrc.cx-backup.XXXXXX")
  cp -p -- "$bashrc" "$backup"
  printf 'Existing .bashrc backed up to %s\n' "$backup"
fi
chmod 600 "$tmp"
mv -f -- "$tmp" "$hook"
if ! [[ -f "$roots" ]] || ! grep -Fxq -- "$root" "$roots"; then
  if [[ -s "$roots" && -n $(tail -c 1 "$roots") ]]; then printf '\n' >> "$roots"; fi
  printf '%s\n' "$root" >> "$roots"
fi
chmod 600 "$roots"
if ! [[ -f "$bashrc" ]] || ! grep -Fq '# cx slurm hook v1' "$bashrc"; then
  printf '\n# cx slurm hook v1\n[[ -r "$HOME/.bashrc.d/cx-interactive.sh" ]] && source "$HOME/.bashrc.d/cx-interactive.sh"\n' >> "$bashrc"
fi
printf 'Remote interactive directory: %s/interactive\n' "$root"
printf 'Remote startup hook: %s\n' "$hook"
if ! command -v squeue >/dev/null 2>&1; then printf 'Note: squeue is not currently in PATH; your shell may need to load the Slurm module.\n'; fi
'''


def read_config():
    if not CONFIG.exists():
        return {}
    value = json.loads(CONFIG.read_text())
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('servers'), dict):
        raise ValueError('Invalid cx Slurm server configuration: ' + str(CONFIG))
    return value['servers']


def save_config(host, root, pattern):
    CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_fd = os.open(str(CONFIG) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with os.fdopen(lock_fd, 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            servers = read_config()
            previous = servers.get(host, {})
            previous = previous if isinstance(previous, dict) else {}
            entry = {'shared_dir': root}
            selected = previous.get('job_id_pattern') if pattern is None else pattern
            if selected:
                entry['job_id_pattern'] = selected
            servers[host] = entry
            fd, temp = tempfile.mkstemp(prefix='.slurm-servers-', dir=CONFIG.parent)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump({'version': 1, 'servers': servers}, stream, indent=2, ensure_ascii=False)
                    stream.write('\n')
                os.replace(temp, CONFIG)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
    except BaseException:
        raise


def main():
    if sys.argv[1:] in (['--help'], ['-h']):
        print('Usage: cx --setup-slurm SSH_ALIAS --shared-dir /absolute/shared/cx-directory [--job-id-pattern REGEX]')
        print('Installs the remote Bash hook and saves this alias’s shared directory. The regex must capture the numeric job ID in one group.')
        return
    if len(sys.argv) == 3 and sys.argv[1] in ('--lookup', '--lookup-pattern'):
        server = read_config().get(sys.argv[2])
        if server is not None:
            root = server.get('shared_dir') if isinstance(server, dict) else None
            if (not isinstance(root, str) or not root.startswith('/') or
                    posixpath.normpath(root) in ('/', '//') or any(c in root for c in ('\n', '\r', '\0'))):
                raise ValueError('Invalid shared directory in ' + str(CONFIG))
            if sys.argv[1] == '--lookup-pattern':
                pattern = server.get('job_id_pattern', '')
                if not isinstance(pattern, str) or any(c in pattern for c in ('\n', '\r', '\0')):
                    raise ValueError('Invalid job-ID pattern in ' + str(CONFIG))
                if pattern and re.compile(pattern.encode()).groups != 1:
                    raise ValueError('Job-ID pattern must contain exactly one capture group.')
                print(pattern)
            else:
                print(posixpath.join(posixpath.normpath(root), 'interactive'))
        return
    if len(sys.argv) not in (4, 6) or sys.argv[2] != '--shared-dir' or (len(sys.argv) == 6 and sys.argv[4] != '--job-id-pattern'):
        raise ValueError('Usage: cx --setup-slurm SSH_ALIAS --shared-dir /absolute/shared/cx-directory [--job-id-pattern REGEX]')
    host, root = sys.argv[1], sys.argv[3]
    pattern = sys.argv[5] if len(sys.argv) == 6 else None
    if pattern is not None:
        if any(c in pattern for c in ('\n', '\r', '\0')):
            raise ValueError('Job-ID pattern cannot contain line breaks.')
        if pattern and re.compile(pattern.encode()).groups != 1:
            raise ValueError('Job-ID pattern must have exactly one capture group for the numeric job ID.')
    if not host or host.startswith('-') or any(c.isspace() or ord(c) < 32 for c in host):
        raise ValueError('Invalid SSH alias.')
    if not root.startswith('/') or root == '/' or any(c in root for c in ('\n', '\r', '\0')):
        raise ValueError('Shared directory must be an absolute path other than /, without line breaks.')
    root = posixpath.normpath(root)
    if root in ('/', '//'):
        raise ValueError('Shared directory must not be /')
    read_config()  # Fail before contacting SSH if local settings are malformed.
    script = Path(__file__).resolve().parent / 'cx-interactive-hook.sh'
    if not script.exists():
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'cx-interactive-hook.sh'
    hook = base64.b64encode(script.read_bytes()).decode('ascii')
    old_hashes = ('a288994fa5a7557566b95328f5f3e5593146f861d2cc69ded7c33c3faf4ee625:'
                  '29ea3304467ff4db52a5d08fe575e85d999dce11b48a5a62ab66641f0ccb2d1c')
    remote_command = ' '.join(map(shlex.quote, ('bash', '-s', '--', root, hook, old_hashes)))
    result = subprocess.run(['ssh', '-T', host, remote_command], input=REMOTE, text=True, check=False)
    if result.returncode:
        raise ValueError('Remote setup failed; local server configuration was not changed.')
    save_config(host, root, pattern)
    print(f'Saved {host!r} → {root}/interactive in {CONFIG}')
    print('Verify that this directory and your Bash startup file are shared with compute nodes. No Slurm allocation was requested.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, re.error, json.JSONDecodeError) as exc:
        print('cx slurm setup: ' + str(exc), file=sys.stderr)
        sys.exit(1)
