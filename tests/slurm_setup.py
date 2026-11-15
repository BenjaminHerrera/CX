#!/usr/bin/env python3
"""Server setup integration tests using a fake SSH transport and isolated home."""
import json
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / 'bin/cx-slurm-setup.py'
HOOK = ROOT / 'scripts/cx-interactive-hook.sh'


class SlurmSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.cx-test-slurm-', dir=ROOT)
        self.path = Path(self.temp.name)
        self.home = self.path / 'remote home'
        self.home.mkdir()
        self.bin = self.path / 'bin'
        self.bin.mkdir()
        (self.bin / 'python3').symlink_to(sys.executable)
        ssh = self.bin / 'ssh'
        ssh.write_text('#!/bin/bash\n[[ "$1" == -T ]] || exit 2\n[[ "$2" != broken ]] || exit 42\nexec bash -c "$3"\n')
        ssh.chmod(0o755)
        self.config = self.path / 'host config' / 'servers.json'
        self.env = dict(os.environ, HOME=str(self.home), CX_SLURM_CONFIG=str(self.config),
                        PATH=str(self.bin) + ':' + os.environ['PATH'])
        self.env.pop('CX_INTERACTIVE_DIR', None)
        (self.home / '.bashrc').write_text('# keep original configuration\n')

    def tearDown(self):
        self.temp.cleanup()

    def run_setup(self, *args, ok=True):
        result = subprocess.run([sys.executable, '-B', str(SETUP), *map(str, args)],
                                env=self.env, text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_setup_is_idempotent_and_keeps_separate_alias_roots(self):
        first = self.path / 'shared directory' / 'cx first'
        second = self.path / 'other cx'
        self.run_setup('alpha', '--shared-dir', first)
        self.run_setup('alpha', '--shared-dir', first)
        self.run_setup('beta', '--shared-dir', second, '--job-id-pattern', r'Job #([0-9]+)')
        self.run_setup('beta', '--shared-dir', second)
        config = json.loads(self.config.read_text())
        self.assertEqual(config['servers']['alpha']['shared_dir'], str(first))
        self.assertEqual(config['servers']['beta']['shared_dir'], str(second))
        self.assertEqual(config['servers']['beta']['job_id_pattern'], r'Job #([0-9]+)')
        self.assertEqual(self.run_setup('--lookup-pattern', 'beta').stdout.strip(), r'Job #([0-9]+)')
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual((first / 'interactive').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.home / '.bashrc.d/cx-interactive.sh').read_bytes(), HOOK.read_bytes())
        self.assertEqual((self.home / '.bashrc').read_text().count('# cx slurm hook v1'), 1)
        self.assertIn('# keep original configuration', (self.home / '.bashrc').read_text())
        roots = (self.home / '.config/cx/slurm-roots').read_text().splitlines()
        self.assertEqual(roots, [str(first), str(second)])
        self.assertEqual(self.run_setup('--lookup', 'alpha').stdout.strip(), str(first / 'interactive'))
        self.assertEqual(self.run_setup('--lookup', 'unconfigured').stdout, '')
        for root, char in ((first, 'a'), (second, 'b')):
            (root / 'interactive' / (char * 32)).touch()
        env = dict(self.env, SLURM_JOB_ID='123')
        result = subprocess.run(['bash', '--noprofile', '--norc', '-ic',
                                 'source "$HOME/.bashrc"; __cx_interactive_ready'],
                                env=env, text=True, capture_output=True, check=True)
        self.assertIn('__CX_READY_' + 'a' * 32 + '_123__', result.stdout)
        self.assertIn('__CX_READY_' + 'b' * 32 + '_123__', result.stdout)
        self.run_setup('beta', '--shared-dir', second, '--job-id-pattern', '')
        self.assertNotIn('job_id_pattern', json.loads(self.config.read_text())['servers']['beta'])

    def test_rejects_unmanaged_hook_and_keeps_existing_local_config(self):
        self.run_setup('existing', '--shared-dir', self.path / 'first')
        original = self.config.read_bytes()
        hook = self.home / '.bashrc.d/cx-interactive.sh'
        hook.write_text('# user-managed hook\n')
        result = self.run_setup('other', '--shared-dir', self.path / 'second', ok=False)
        self.assertIn('not a recognized cx hook', result.stderr)
        self.assertEqual(hook.read_text(), '# user-managed hook\n')
        self.assertEqual(self.config.read_bytes(), original)

    def test_upgrades_original_managed_hook(self):
        old = '''# Source from an interactive compute-node Bash startup file. The marker uses
# ordinary printable text so GNU screen can repaint it when attaching.
if [[ $- == *i* && ${SLURM_JOB_ID:-} =~ ^[0-9]+$ && -z ${__cx_interactive_hook_installed:-} ]]; then
    __cx_interactive_hook_installed=1
    __cx_interactive_ready() {
        local __cx_file __cx_token
        for __cx_file in "${CX_INTERACTIVE_DIR:-/projects/$USER/.resources/cx-interactive}/"*; do
            [[ -f $__cx_file && ! -L $__cx_file ]] || continue
            __cx_token=${__cx_file##*/}
            [[ $__cx_token =~ ^[0-9a-f]{32}$ ]] || continue
            printf '\\r\\n__CX_READY_%s_%s__\\n' "$__cx_token" "$SLURM_JOB_ID"
        done
    }
    if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
        PROMPT_COMMAND+=(__cx_interactive_ready)
    elif [[ -n ${PROMPT_COMMAND:-} ]]; then
        PROMPT_COMMAND="${PROMPT_COMMAND}; __cx_interactive_ready"
    else
        PROMPT_COMMAND=__cx_interactive_ready
    fi
fi
'''
        self.assertEqual(hashlib.sha256(old.encode()).hexdigest(),
                         'a288994fa5a7557566b95328f5f3e5593146f861d2cc69ded7c33c3faf4ee625')
        hook = self.home / '.bashrc.d/cx-interactive.sh'
        hook.parent.mkdir()
        hook.write_text(old)
        self.run_setup('alpine', '--shared-dir', self.path / 'configured')
        self.assertEqual(hook.read_bytes(), HOOK.read_bytes())
        self.assertNotIn('/projects/$USER/.resources/cx-interactive', hook.read_text())

    def test_upgrades_recent_managed_hook(self):
        current = HOOK.read_text()
        old = current.replace('        fi\n        for __cx_root',
                              '            __cx_roots+=("/projects/$USER/.resources/cx-interactive")\n'
                              '        fi\n        for __cx_root')
        self.assertEqual(hashlib.sha256(old.encode()).hexdigest(),
                         '29ea3304467ff4db52a5d08fe575e85d999dce11b48a5a62ab66641f0ccb2d1c')
        hook = self.home / '.bashrc.d/cx-interactive.sh'
        hook.parent.mkdir()
        hook.write_text(old)
        self.run_setup('alpine', '--shared-dir', self.path / 'configured')
        self.assertEqual(hook.read_bytes(), HOOK.read_bytes())

    def test_rejects_unsafe_directory_invalid_input_and_ssh_failure(self):
        root = self.path / 'public'
        (root / 'interactive').mkdir(parents=True, mode=0o755)
        (root / 'interactive').chmod(0o755)
        self.assertIn('private', self.run_setup('alpha', '--shared-dir', root, ok=False).stderr)
        self.run_setup('alpha', '--shared-dir', 'relative', ok=False)
        self.run_setup('alpha', '--shared-dir', '//', ok=False)
        self.run_setup('-oProxyCommand=bad', '--shared-dir', self.path / 'cx', ok=False)
        self.run_setup('alpha', '--shared-dir', self.path / 'cx', '--job-id-pattern', 'no capture', ok=False)
        self.run_setup('alpha', '--shared-dir', self.path / 'cx', '--job-id-pattern', '(', ok=False)
        self.run_setup('broken', '--shared-dir', self.path / 'cx', ok=False)
        self.assertFalse(self.config.exists())

    def test_cx_entrypoint_runs_setup_without_docker(self):
        root = self.path / 'cluster cx'
        result = subprocess.run(['bash', str(ROOT / 'bin/cx'), '--setup-slurm', 'gamma',
                                 '--shared-dir', str(root)], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('gamma', result.stdout)
        self.assertEqual(json.loads(self.config.read_text())['servers']['gamma']['shared_dir'], str(root))

    def test_invalid_local_config_is_rejected_before_ssh(self):
        self.config.parent.mkdir()
        self.config.write_text('not-json')
        root = self.path / 'untouched'
        self.run_setup('gamma', '--shared-dir', root, ok=False)
        self.assertFalse(root.exists())

    def test_ssh_session_receives_selected_alias_path_and_pattern(self):
        root = self.path / 'shared ssh path'
        self.run_setup('alpha', '--shared-dir', root, '--job-id-pattern', r'Allocation #([0-9]+)')
        self.run_setup('beta', '--shared-dir', self.path / 'beta')
        python = self.bin / 'python3'
        python.unlink()
        python.write_text('#!/bin/bash\nif [[ "$1" == */cx-ssh-bridge.py ]]; then\n'
                          '  printf "%s\\n%s\\n" "$CX_SLURM_INTERACTIVE_DIR" "$CX_SLURM_JOB_ID_PATTERN" > "$CX_TEST_CAPTURE"\n'
                          '  exit 0\nfi\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
        python.chmod(0o755)
        docker = self.bin / 'docker'
        docker.write_text('#!/bin/bash\nexit 0\n')
        docker.chmod(0o755)
        project = self.path / 'project'
        project.mkdir()
        capture = self.path / 'captured env'
        master, slave = os.openpty()
        try:
            result = subprocess.run(['bash', str(ROOT / 'bin/cx'), str(project), '--ssh', 'alpha'],
                                    env=dict(self.env, CX_TEST_CAPTURE=str(capture)),
                                    stdin=slave, stdout=slave, stderr=slave, timeout=10)
            self.assertEqual(result.returncode, 0, os.read(master, 8192).decode(errors='replace') if result.returncode else '')
        finally:
            os.close(master)
            os.close(slave)
        self.assertEqual(capture.read_text().splitlines(), [str(root / 'interactive'), r'Allocation #([0-9]+)'])

    def test_installed_cx_includes_hook_and_can_run_setup(self):
        prefix = self.path / 'installed prefix'
        result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--prefix', str(prefix), '--no-build'],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = prefix / 'share/cx/program/bin/cx-interactive-hook.sh'
        self.assertEqual(installed.read_bytes(), HOOK.read_bytes())
        root = self.path / 'shared installed'
        result = subprocess.run([str(prefix / 'bin/cx'), '--setup-slurm', 'installed-host',
                                 '--shared-dir', str(root)], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / '.bashrc.d/cx-interactive.sh').read_bytes(), HOOK.read_bytes())


if __name__ == '__main__':
    unittest.main()
