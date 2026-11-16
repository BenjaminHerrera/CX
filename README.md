# cx — Codex and Claude Code in Docker

Use either CLI with a local project, named accounts and persistent development
environments. Browse conversations in a terminal session menu, or connect to an
SSH server for remote commands, file access and Slurm CPU/GPU sessions.

[**User Handbook**](docs/README.md) · [**GitHub Wiki**](https://github.com/BenjaminHerrera/CX/wiki) ·
[Command Reference](docs/USAGE.md) · [Changelog](CHANGELOG.md) ·
[Issues](https://github.com/BenjaminHerrera/CX/issues/new/choose)

## Quick Start

Use Linux or WSL2, a local Docker daemon, Bash 4+, host Python 3.11+ and an
account for your chosen CLI. Run on your host, outside CX:

```bash
git clone https://github.com/BenjaminHerrera/CX.git
cd CX
./install.sh
export PATH="$HOME/.local/bin:$PATH"
cx --doctor
cx accounts add --agent codex --account personal --auth subscription
cx --agent codex --account personal --login
cx /path/to/project
```

Complete the displayed provider sign-in. Add the PATH export to your Bash
startup file for future terminals. For Claude, create a profile with
`--agent claude --account work`, use the same pair with `--login`, then launch
with that pair or select it in the account picker. The
[Getting Started guide](docs/GETTING-STARTED.md) walks through both choices.

The `v2` integration is now on `main`. Use `main` for installs and new work;
the package version is **2.1.0**. This version adds a yellow shortcut Help Menu
to every CX header, available with Ctrl-] ?, while preserving saved assistants,
drafts and Sessions state. See [upgrading](docs/UPGRADING.md) for existing
installations and image rebuilds.

## Everyday Use

```bash
cx .                                      # Choose a CLI/account and open this project
cx sessions select .                      # Start at the conversation menu
cx . --add-dir ../shared                   # Share another local directory
cx . --add-file "$HOME/notes.md"            # Share one writable file
cx --agent codex --account personal . exec "Run the tests"
cx . --ssh my-server --remote-dir /remote/projects/app --ssh-mount
```

Inside an interactive session, press **Ctrl-]**, then **s** for Sessions.
Use arrows to highlight a named conversation, `r` to rename, or `d` to delete
with confirmation. Enter queues resume; exit the current assistant cleanly
to complete the switch. [Sessions](docs/SESSIONS.md) explains filters, account
changes, shared-history deletion and all shortcuts.

```text
/workspace/
├── main/          selected local project
├── cx-external/   additional local files and directories
└── remote/        optional SSHFS view
```

Edits to writable mounts update the original files. Accounts isolate credentials
and settings; conversations are shared among accounts of the same CLI. Codex
and Claude histories remain separate, and native ownership restrictions apply.

## Find Your Guide

| Task | Guide |
|---|---|
| Install, sign in and run a first session | [Getting Started](docs/GETTING-STARTED.md) |
| Resume, rename, switch or delete conversations | [Sessions](docs/SESSIONS.md) |
| Bring ordinary Codex/Claude conversations into CX | [Import Native Sessions](docs/IMPORTING.md) |
| Share files and keep tools between runs | [Workspaces and Environments](docs/WORKSPACES.md) |
| Use an SSH alias and browse server files | [SSH and Remote Files](docs/SSH.md) |
| Configure `cpu`/`gpu` allocation bridging | [Slurm Setup](docs/SLURM.md) |
| Update, back up or recover an installation | [Upgrade and Back Up](docs/UPGRADING.md) |
| Diagnose a problem or request help | [Troubleshooting](docs/TROUBLESHOOTING.md) |

## Access and Contributing

CX is an independent wrapper, not an official OpenAI or Anthropic product.
It uses the invoking user's UID; Claude permission bypass needs a non-root
user. Writable files, account settings and environments can be changed by the
assistant. SSH commands use the remote account's permissions even with a
read-only file mount. Read the [access model](docs/ARCHITECTURE.md#access-boundaries).

See [Contributing](CONTRIBUTING.md), [Development](docs/DEVELOPMENT.md),
[Support](SUPPORT.md), [Security](SECURITY.md) and [Code of Conduct](CODE_OF_CONDUCT.md).
Live platform/provider limitations are recorded in the handbook; offline tests
do not establish every terminal, server or scheduler configuration.

## License Status

The original CX code has **no distribution license**. Public availability does
not grant an open-source license. Bundled dependencies retain their
[upstream licenses](bin/vendor/README.md).
