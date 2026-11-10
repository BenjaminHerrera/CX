# cx — Codex in a Docker container

**Version 1.2.1.** Run Codex in a disposable Docker container with your local
project, selected extra directories or files, and optional SSH access. Edits
update the original files. Credentials, settings, and development environments
persist between sessions.

Version 1.2.1 adds interactive MCP sessions for the existing `cpu` and `gpu`
functions. `cx --setup-slurm` installs the remote hook and saves a shared cx
directory per SSH alias. The hook confirms the Slurm allocation shell before cx
sends commands. See the [changelog](CHANGELOG.md) and
[interactive setup](docs/USAGE.md#interactive-cpu-and-gpu-sessions).

## Requirements

- Linux or a Linux distribution inside WSL2, with Bash 4+, GNU coreutils,
  `sed`, and `tar`/`gzip`.
- A running **local Docker daemon** accessible to your user. For WSL2, enable
  Docker Desktop integration for your distribution. Remote Docker daemons
  cannot bind-mount your local project paths correctly.
- Internet access for image builds, sign-in, and Codex requests, plus an
  account with Codex access.
- Resources for the default main container limits: 8 GB memory, 4 CPUs, and
  1,024 processes. These limits are configurable.

Local sessions do not need host Node.js, Micromamba, Python, or SSH setup.
Optional SSH sessions need host Python 3.11+, OpenSSH, an interactive
terminal, and a remote Bash shell. Optional remote filesystem mounts also
need host SSHFS/FUSE and server SFTP access. See [SSH setup](docs/INSTALL.md#optional-ssh-prerequisites).
Native macOS and Windows shells are outside this package's supported scope.

## Install or upgrade

From the updated repository or extracted install release:

```bash
./install.sh
```

This installs into `~/.local` and builds the Docker image. Existing managed
installations are backed up; credentials, environments, and the installed
system configuration are preserved. Reuse `--prefix /your/original/prefix`
if you originally selected a custom prefix.

Add the launcher directory to your shell profile if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then sign in and start a session:

```bash
cx --doctor
cx --login
cx /path/to/project
```

Use the device-login link and code printed during sign-in. See the
[installation guide](docs/INSTALL.md) for authentication, custom paths,
rollback, and removal.

**Upgrading from 1.1.x:** run `./install.sh` with its default image build,
then restart sessions. MCP requires the new container adapter. Saved settings,
credentials, and environments are preserved. A host-only update can use an
older image with `--ssh HOST --no-ssh-mcp`; rebuild before enabling MCP.

**Upgrading from 1.0.x or older:** rebuild the image and migrate container
paths to the three-folder workspace layout. Review the new default
instructions against your preserved installed configuration.
[Upgrade details](docs/INSTALL.md#upgrading-to-121).

## Workspace layout

Sessions start at `/workspace`. Running `ls -al` shows:

```text
/workspace/
├── main/          # contents of the selected local project
├── cx-external/   # extra local directories and individual files
└── remote/        # optional SSHFS view of the remote project
```

For `cx ~/projects/app`, the contents of that directory appear directly in
`main/`. These are container paths; cx does not create these folders inside
your local project. Unused `cx-external/` and `remote/` folders remain empty.

## Local commands

```bash
cx .                                      # Select the current local project
cx . exec "Run the tests and fix failures" # Run a non-interactive task
cx . --add-dir ../shared                   # Share another writable directory
cx . --add-file ~/notes.md                 # Share one existing writable file
cx --shell                                # Open a shell at /workspace
cx --auth-status                          # Check Codex sign-in
cx --build                                # Build with cached layers
cx --rebuild                              # Refresh base image and rebuild all layers
cx --help                                 # Show options
```

Repeat or combine `--add-dir` and `--add-file`. Relative paths resolve from
the selected local project. Extra files and directories appear under
`/workspace/cx-external`; project files already under `main/` keep their
existing location. Individual file mounts require **in-place writes**;
rename-based replacement and deletion of their mountpoints are unsupported.
See [usage](docs/USAGE.md) for naming, filtering, and configuration.

## Optional SSH sessions

```bash
mkdir -p ~/cx-remote
cx ~/cx-remote --ssh delta --remote-dir /srv/project
```

`delta` uses your host's SSH configuration and credentials. Complete login
and MFA directly in the terminal. At a Bash prompt, press **Ctrl-]**, then
**c** to start Codex. **Ctrl-] r** returns to the SSH terminal for interaction.
The colored bar always identifies the active screen. **Ctrl-] q** exits the
SSH-mode session. No tmux installation is needed; the screen renderer is
bundled with cx. Use the wheel to scroll; **Shift-drag** selects text for
copying. In Windows Terminal, copy with **Ctrl+Shift+C**. **Ctrl-] b** returns
to the live view, and **Ctrl-] m** toggles wheel capture for plain drag selection.
Commands share a persistent remote shell:

```bash
# Inside the cx session:
cx-remote status
cx-remote exec 'hostname; pwd; ls'
```

Add `--ssh-mount` to browse remote files at `/workspace/remote`, read-only.
Use `--ssh-mount=rw` to allow direct remote edits:

```bash
cx ~/cx-remote --ssh delta --remote-dir /srv/project --ssh-mount
cx ~/cx-remote --ssh delta --remote-dir /srv/project --ssh-mount=rw
```

Remote command execution stays available in either mode. The local project
remains at `/workspace/main`. See [SSH usage](docs/USAGE.md#work-through-ssh)
for authentication, mount permissions, reconnection, and Delta/Slurm behavior.

## Installed and portable editions

| | Installed | Portable |
|---|---|---|
| Start | `cx /path/to/project` | `/path/to/bundle/cx /path/to/project` |
| Program | `~/.local/share/cx/program` | Extracted folder |
| Credentials and settings | `~/.codex` | `bundle/data/codex` |
| Development environments | `~/.local/share/cx/environments` | `bundle/data/environments` |

Both editions require Docker. Portable archives contain source, not a prebuilt
image. From a fresh portable bundle:

```bash
./cx --build
./cx --login
./cx /path/to/project
```

Select a project **outside the bundle**, since its `data/` contains private
credentials. Keep the bundle together when moving it. Portable mode does not
modify PATH or install into `~/.local`.

## Documentation and verification

- [Installation, upgrades, and removal](docs/INSTALL.md)
- [Commands, SSH, mounts, environments, and troubleshooting](docs/USAGE.md)
- [Architecture, persistence, and access](docs/ARCHITECTURE.md)
- [Tests and release packaging](docs/MAINTAINING.md)
- [Changelog](CHANGELOG.md)

CPU and GPU interactive MCP sessions were verified with small live Alpine
allocations, including execution on compute nodes and cleanup. This does not
verify other sites or allocation modes. SSHFS tests mock mounting; live Windows
Terminal/WSL, Docker, FUSE, sign-in, and Delta MFA require separate checks.
Run `./scripts/verify-docker.sh --build` on a Docker host
for container verification, then follow the live SSH checklist in the
maintenance guide.

Create clean `1.2.1` install and portable archives with
`./scripts/package.sh`. Archives and checksums go into `dist/`; packaging
excludes credentials, runtime data, and caches. Never distribute a used
portable bundle's private `data/` directory.
