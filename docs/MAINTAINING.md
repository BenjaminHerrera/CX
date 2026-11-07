# Maintenance and verification

The launcher is Bash; the optional host SSH bridge uses Python 3.11+ standard
library modules. The container client and wrapper tests use Node.js built-in
modules. No third-party Python or npm packages are needed for these tests.
Host Node.js is needed for maintenance, not ordinary cx use. Host Python is
required only for SSH mode and its tests.

## Offline checks

Run from the repository or an extracted release. Installed program folders
contain runtime code and documentation, while tests and maintenance scripts
remain in the source distribution.

```bash
node tests/smoke.mjs
node tests/remote-client.mjs
python3 -B tests/ssh_bridge.py
```

| Suite | Coverage |
|---|---|
| `smoke.mjs` | Shell syntax, Docker argument generation, workspace layout, file/directory mounts, masking, piped tasks, credential/path rejection, install/upgrade/removal, environments, packaging, and extracted editions |
| `remote-client.mjs` | Command transport, quoting, streamed output, and returned exit status |
| `ssh_bridge.py` | Real PTYs with fake SSH, persistent shell state, framing, terminal handoff, resizing/restoration, manual input exclusion, and mocked SSHFS setup/cleanup/instructions |

The suites use temporary fixtures, never sign in, and never send model
requests. The wrapper suite uses fake Docker. The SSH suite requires Linux
PTYs and Python 3.11+; it mocks FUSE operations. Passing these tests does not
establish live Docker, SFTP, SSHFS, or authentication compatibility.

## Live Docker verification

On a supported host with a local Docker daemon:

```bash
./scripts/verify-docker.sh --build
```

This builds the image, packages and extracts both editions, installs to a
disposable prefix, and runs containers against temporary projects. It checks
the three-folder workspace layout, project and added-directory writes,
standalone file writes, read-only ignore masks, and persistent storage. It
uses disposable credential stores and makes no sign-in or model requests.
Fixtures are removed afterward. Omit `--build` to use an existing image.

The source directory must be writable. Tests exercise paths containing spaces.
Afterward, use a disposable project to validate live Codex sign-in and account
access. Check each architecture and Docker mode you intend to support.

## Live SSH and mount verification

On a host with Python 3.11+, OpenSSH, SSHFS/FUSE, and an accessible SSH/SFTP
server, use a disposable remote directory:

1. Start an SSH session with a configured alias and `--remote-dir`. Complete
   login/MFA directly, then press Ctrl-] c. Check `cx-remote status` and run
   commands that change directory and export a variable; confirm state persists.
2. Switch with Ctrl-] r and Ctrl-] c. Check manual interaction, resizing,
   interruption, and reconnection. Disconnected commands must not be replayed.
3. Start with `--ssh-mount` and inspect `/workspace/remote`. Confirm reads
   succeed and writes through the mount fail. Confirm remote command execution
   still works.
4. Repeat with `--ssh-mount=rw`, write a disposable file through the mount,
   and verify its contents on the server. Exit and confirm the owned SSHFS
   mount is gone. Exercise mount failure and busy-unmount recovery separately.
5. Validate Delta MFA and any manual Slurm allocation workflow on Delta itself.
   The mount stays on the configured SSH host; it does not follow compute nodes.

Current repository validation covers the offline suites. Live Docker builds,
Docker bind mounts, SSHFS/FUSE, real sign-in, and Delta MFA remain unverified
in the supplied environment.

## Build shareable archives

Update `VERSION`, the changelog, and release-specific documentation first:

```bash
./scripts/package.sh
cd dist
sha256sum -c SHA256SUMS
```

For version 1.1.0 the outputs are:

```text
dist/
├── cx-1.1.0-install.tar.gz
├── cx-1.1.0-portable.tar.gz
└── SHA256SUMS
```

Each archive contains a versioned top-level directory, `START-HERE.txt`,
documentation, runtime helpers, maintenance tools, tests, and a per-file
`MANIFEST.sha256`. Verify extracted files with
`sha256sum -c MANIFEST.sha256`. The outer checksums verify the compressed
archives. Use `./scripts/package.sh --output /some/directory` for another
destination. Docker images are not bundled.

Packaging uses the explicit list in `scripts/package.sh`; review it when
adding files. Do not replace it with `tar .`, since a working portable bundle
can contain credentials and environments. `data/`, `dist/`, logs, test
fixtures, and Python bytecode are ignored by Git and excluded from archives.
Keep intended runtime helpers and tests in the release file list even when
those files have not yet been committed.

## Source lineage

The original inputs were `.local/bin/cx`,
`.local/bin/cx-config/config.toml`, and the Dockerfile, `cx-entrypoint`, and
`cx-env` under `.local/share/cx`. Personal settings, credentials, workspace
metadata, and existing environments were not imported into the repository.

The original files had no license notice. The source owner should choose a
distribution license before public publication; this package does not assign
one on their behalf. Container components retain their upstream licenses.
