# CX User Handbook

Start with [Getting Started](GETTING-STARTED.md) if this is your first CX session.
The same guides are published in the [GitHub Wiki](https://github.com/BenjaminHerrera/CX/wiki).
Repository Markdown is the source of truth and is included in both distribution editions.

## Set Up and Use CX

| Guide | What you will learn |
|---|---|
| [Getting Started](GETTING-STARTED.md) | Check prerequisites, install, choose Codex or Claude, sign in and open a project |
| [Installation](INSTALL.md) | Custom prefixes, portable bundles, Docker/FUSE prerequisites and removal |
| [Accounts and History Reference](ACCOUNTS.md) | Subscription/API-key profiles, authentication, shared storage and native ownership limits |
| [Sessions](SESSIONS.md) | Open the menu, search, rename, delete and switch between saved assistants |
| [Workspaces and Environments](WORKSPACES.md) | Host/container paths, extra files, filtering and persistent development tools |
| [SSH and Remote Files](SSH.md) | Connect through an alias, hand off authentication, use commands and mount server files |
| [Watch for Changes](WATCH.md) | Follow GitHub, commands and files from a background monitor |
| [Slurm Setup](SLURM.md) | Choose shared paths per alias and use existing CPU/GPU allocation functions |
| [Import Native Sessions](IMPORTING.md) | Copy ordinary CLI histories, preview changes and handle conflicts or missing rollouts |
| [Upgrade and Back Up](UPGRADING.md) | Adopt the merged main branch, rebuild images and preserve private data |
| [Troubleshooting](TROUBLESHOOTING.md) | Diagnose startup, menu, terminal, mount and allocation problems |
| [Command and Configuration Reference](USAGE.md) | Complete options, settings, paths and remote-tool contracts |

## Understand the Data Model

- **Account:** a named Codex or Claude profile with private credentials/settings.
- **Session:** a conversation, shared among accounts of its original CLI.
- **Workspace:** a local project mounted at `/workspace/main`, with optional extras and remote view.
- **SSH shell:** a separate stateful remote terminal; the assistant still runs locally in Docker.
- **Environment:** a persistent named development environment associated with the local project's path.

CX does not translate histories between CLIs, bypass native account restrictions,
or make remote commands read-only when a file mount is read-only. See the
[access model](ARCHITECTURE.md#access-boundaries).

## Contribute or Maintain

| Guide | Purpose |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Issues, branches from main, PR review and project policies |
| [Development](DEVELOPMENT.md) | Component map, local setup and appropriate checks |
| [Architecture](ARCHITECTURE.md) | Persistence, terminal supervision and access boundaries |
| [Maintenance](MAINTAINING.md) | Native/runtime verification and packaging |
| [GitHub Maintenance](GITHUB.md) | Wiki publication, issue triage, repository settings and releases |
| [V2 Integration History](V2.md) | Completed integration scope and links to its merged PRs |
| [Support](../SUPPORT.md) | Report a reproducible problem with redacted output |
| [Security](../SECURITY.md) | Report vulnerabilities privately |
| [Code of Conduct](../CODE_OF_CONDUCT.md) | Community expectations |

## Validation and Versions

The multi-CLI and menu integration is merged into `main`; `v2` is no longer
the implementation base. The current package version is **2.2.1**, including
deferred cleanup for Claude session deletion and stable identities for
switching back to running Claude sessions.
Use [Upgrade and Back Up](UPGRADING.md) for the current source workflow.

Version 2.2.0 includes [`cx-watch`](WATCH.md),
[automatic SSH session selection](SSH.md#connect-with-an-existing-alias)
and [`cx test_connection`](USAGE.md#test-both-provider-connections). See the
[CX-18 validation record](MAINTAINING.md#cx-18-watcher-and-session-maintenance-validation)
for the automated checks and owner-confirmed test result.

Version 2.1.2 includes the CX-13 SSH MCP startup fix. Both editions need an
image rebuild. Docker image and packaged-startup verification passed on the
owner's host. Codex and Claude also called `ssh_status` against a simulated
bridge in the native-client fixture. See the
[CX-13 validation record](MAINTAINING.md#cx-13-validation-target-v212).

[CX-2 validation](CX2-VALIDATION.md) and [CX-7 validation](CX7-VALIDATION.md)
record implementation-time evidence and remaining live checks. A merged PR
does not turn a skipped provider, Windows Terminal, Docker or scheduler test
into a verified result. [Changelog](../CHANGELOG.md) records user-visible changes.
