# cx — Codex and Claude Code in Docker

Run Codex or Claude Code against your local project in a disposable Docker container, with
persistent settings and development environments. Connect to an SSH host for
remote commands, file access, and interactive Slurm CPU/GPU sessions.

**Version 1.2.1** · [Documentation](docs/README.md) · [Changelog](CHANGELOG.md) ·
[Issues](https://github.com/BenjaminHerrera/CX/issues/new/choose)

## Features

- A consistent workspace for your project, extra directories, and individual files.
- Named accounts with private credentials/settings and shared history within each CLI.
- Installed and portable editions with persistent development environments.
- Optional SSH mode with separate terminal screens, tracked commands, and MCP tools.
- Optional SSHFS browsing/editing and per-server Slurm interactive setup.

cx is an independent wrapper; it is not an official OpenAI or Anthropic product.

## Requirements

Linux or WSL2 with Bash 4+, GNU coreutils, `sed`, `tar`/`gzip`, a running
**local Docker daemon** accessible to your user, internet access, and an account
with access to the selected CLI. Claude permission bypass requires a non-root user. Default container limits are 8 GB memory and 4 CPUs;
[these are configurable](docs/USAGE.md#settings).

SSH additionally requires host Python 3.11+, OpenSSH, an interactive terminal,
and remote Bash. Remote file mounts require SSHFS/FUSE and server SFTP support.
Native macOS and Windows shells are outside the supported scope.

## Quick start

On your Linux/WSL host:

```bash
git clone https://github.com/BenjaminHerrera/CX.git
cd CX
./install.sh
export PATH="$HOME/.local/bin:$PATH"  # Add to your shell profile if needed
cx --doctor
cx accounts add --agent codex --account personal --auth subscription
cx --agent codex --account personal --login
cx /path/to/project
```

The installer builds the image and installs to `~/.local`. Complete the displayed
device-login steps. See [installation](docs/INSTALL.md) for custom prefixes,
portable archives, upgrades, rollback, and removal.

## Everyday use

```bash
cx .                                      # Open the current project
cx --agent codex --account personal . exec "Run the tests and fix failures"  # Run a non-interactive task
cx . --add-dir ../shared                   # Share another writable directory
cx . --add-file ~/notes.md                 # Share one existing writable file
cx --shell                                # Open a container shell
cx --help                                 # Show launcher options
```

Interactive launches show a combined CLI/account picker. Scripts need an explicit
pair or an automation default. See [accounts and history](docs/ACCOUNTS.md) to add
Claude accounts, use API keys, resume conversations, or retain a legacy home.
Remove a profile with `cx accounts remove NAME`; shared history is preserved.
Managed Codex `resume` provides a shared-history picker; native Codex performs
the selected resume and retains any account ownership restrictions.
Both CLIs support SSH/MCP/Slurm through the shared bridge. Live parity validation
is tracked in CX-2.

Inside the container:

```text
/workspace/
├── main/          # Selected local project
├── cx-external/   # Added local directories and files
└── remote/        # Optional SSHFS view
```

Edits to writable mounts update the original files. Individually mounted files
require in-place writes; replacing their mountpoints by rename is unsupported.
See [usage](docs/USAGE.md) for filtering, persistence, and configuration.

## Optional SSH and Slurm

Use an alias from your host SSH configuration:

```bash
cx /path/to/local/project --ssh my-server --remote-dir /remote/project
# Add --ssh-mount for read-only file browsing, or --ssh-mount=rw for edits.
```

Complete login/MFA directly. At the remote Bash prompt, press **Ctrl-]**, then
**c** to enter Codex; **Ctrl-] r** returns to SSH. The top bar identifies the
active screen. MCP tools and `cx-remote` share the remote shell.

For Slurm, first run `cx --setup-slurm my-server --shared-dir /shared/myuser/cx`
on your host. The server must provide compatible `cpu` and `gpu` Bash functions.
Read [SSH usage](docs/USAGE.md#work-through-ssh) and
[interactive setup](docs/USAGE.md#interactive-cpu-and-gpu-sessions) before allocating resources.

## Access, support, and contributing

Codex can modify writable mounts and persisted settings. SSH commands use your
remote account's permissions, even when the remote file mount is read-only.
Review the [access model](docs/ARCHITECTURE.md#access-boundaries) before use.

- [Support and troubleshooting](SUPPORT.md)
- [Contribution process](CONTRIBUTING.md) and [development guide](docs/DEVELOPMENT.md)
- [Security policy](SECURITY.md) and [community conduct](CODE_OF_CONDUCT.md)

## License status

The original cx code currently has **no distribution license**. Public source
availability does not grant an open-source license. Bundled dependencies retain
their [upstream licenses](bin/vendor/README.md).
