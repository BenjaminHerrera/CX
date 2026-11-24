# Upgrade and Back Up

[Handbook home](README.md) · [Installation reference](INSTALL.md#updates)

## Update from an Earlier CX Checkout

The multi-CLI and session-menu work formerly developed on `v2` is now merged
into `main`. New installations and upgrades should use `main`. The branch name
did not itself assign a semantic release number. The current package version
is **2.1.3**. No published release archive is required to
install from source.

1. Exit running CX sessions and stop other writers before moving/backing up data.
2. Back up the private paths below. Keep backups out of Git and release archives.
3. Update a clean host checkout and run the installer:

```bash
git switch main
git pull --ff-only
./install.sh
cx --version
# Expected: cx 2.1.3
cx --doctor
```

Commit or preserve local edits before pulling. If you installed with a custom
prefix, repeat `./install.sh --prefix /your/prefix`. The installer builds the
image, preserves installed system configuration, and backs up the old program.
Restart CX afterwards. Host files and image contents are separate updates;
`./install.sh --no-build` updates only the host program. Build the image before
using features that require updated container adapters. `cx --rebuild` also
refreshes cached image layers and CLI packages.

## SSH Handoff and Provider Checks From Main

Update the host program and start a new CX session to use automatic SSH
handoff and `cx test_connection`. Both changes work with a compatible existing
CX image. If you are also adding GitHub CLI support, follow the rebuild steps
below. See the [SSH startup flow](SSH.md#connect-with-an-existing-alias) and
the [provider check](USAGE.md#test-both-provider-connections).

## GitHub CLI Access From Main

To use `gh` from Codex or Claude, update the host program and rebuild the
image. The installer builds the image by default. If you updated with
`./install.sh --no-build`, run `cx --rebuild`. For a portable bundle, run
`./cx --rebuild` from the updated bundle. Then start a new assistant session
with a [GitHub token file](ACCOUNTS.md#github-cli-access).

## CX-15 Codex Sessions History Fix in v2.1.3

After updating, open Sessions to restore entries whose old temporary menu path
still has a matching transcript in managed history. The helper checks the full
session ID in the filename and transcript before repairing the cached path.
Entries with missing or mismatched transcripts are left alone. Upgrading from
2.1.2 can use `./install.sh --no-build` because the menu helper ships with the
launcher.

## CX-13 MCP Startup Fix in v2.1.2

The CX-13 MCP startup fix is merged into `main` in
[PR #14](https://github.com/BenjaminHerrera/CX/pull/14), targeting v2.1.2.
Rebuild the Docker image in either edition, not only the host launcher.
This differs from the host-only metadata layout fix in 2.1.1. See
[MCP rebuild guidance](INSTALL.md#cx-13-mcp-adapter-rebuild-target-v212)
for installed/portable commands, permission/load diagnostics and the temporary
`--no-ssh-mcp` fallback. The owner confirmed that the Docker verification script
passed; [validation details](MAINTAINING.md#cx-13-validation-target-v212)
record the Docker results and native MCP calls against a simulated bridge.

## Changes in 2.1.1

Sessions metadata now uses the longest metadata string in the filtered list
instead of a fixed-width column. This reduces empty space, keeps separators
aligned across pages, and recalculates when filters or terminal width change.
Narrow terminals retain space for names and the existing stacked layout.
Update the host program and restart CX; this layout fix needs no image rebuild
or data migration.

## Changes in 2.1.0

Every CX header now offers **Ctrl-] ?: Help Menu**. Press Ctrl-], release it,
then press ?. Help uses a yellow banner, shortcut badges with one space on
both sides and aligned definitions. It lists keybindings only, including
controls for the current Sessions modal. Esc restores the previous view,
draft, scroll position, filters and editing state. Bare ? and pasted text
remain ordinary input. Help does not authenticate, reconnect or interrupt work.

Headers use `VIEW[/account]  --  Ctrl-] ?: Help Menu`; history offsets and
operational notices appear separately in the footer or view body. The help
banner is yellow; leaving help restores the prior blue or green banner.

Update installed/portable program files and restart CX to load the new host
help module. No new runtime dependency or data migration is required. Users
already running the 2.0.1 image do not need to rebuild solely for this host UI
change; rebuild to refresh its MCP version metadata or when upgrading older
adapters. Source archives do not include a prebuilt Docker image.

## Changes in 2.0.1

Enter in Sessions now switches immediately while keeping the previous assistant
alive. Select its `[running]` row to restore its process, screen and draft.
Background work can continue, and Ctrl-] q exits CX and stops all its saved
assistants. The menu defaults to name sorting and compact rows, aligns its
metadata column, and colors Codex rows light blue and Claude rows orange.
SSH authentication and active-command safety gates still apply. See
[Sessions](SESSIONS.md) for lifecycle details and temporary rows for unknown IDs.

Reinstall or update portable program files and restart CX to load these host
menu changes. Rebuild the image when upgrading from older 1.x adapters; no
credentials or histories are migrated automatically. Live-check limitations
remain recorded in the [validation notes](README.md#validation-and-versions).

## Keep the Right Data

| Content | Default installed location |
|---|---|
| Account credentials, shared histories and CX session names | `~/.local/share/cx/data` |
| Persistent workspace environments | `~/.local/share/cx/environments` |
| Preserved system configuration | `~/.local/share/cx/config` |
| Per-alias Slurm registry | `~/.config/cx/slurm-servers.json` |
| Projects and standalone added files | Their original host paths |
| Server files and Slurm shared roots | Their original remote paths |

Honor `CX_DATA_HOME`, `CX_ENV_HOME`, `CX_CONFIG_DIR`, `XDG_CONFIG_HOME` and
`CX_SLURM_CONFIG` overrides when locating your data. Copy complete private
trees with writers stopped, preserving permissions and SQLite sidecars. An
installer program backup is not a backup of conversation history or projects.

## Migrate Older Account Homes

Managed profiles start fresh and need their own login. To copy ordinary native
histories, follow [Import Native Sessions](IMPORTING.md). The importer does not
copy credentials.

An explicit `CX_CODEX_HOME` keeps legacy Codex behavior and bypasses managed
accounts and Sessions. To adopt managed mode, unset it, create a profile and
sign in. The old native directory remains in place. Source/destination overlap
rules still apply if you later import from it.

For Slurm, rerun `cx --setup-slurm ALIAS --shared-dir /shared/your/cx` for each
alias needing the managed remote hook or a different shared root. Setup does
not request an allocation.

## Portable Updates and Rollback

Extract a fresh portable bundle outside your project. With sessions stopped,
transfer its private `data/` and merge intentional config changes, then build
the new bundle's image. Do not replace saved data with an empty directory or
publish a used bundle. Workspace environments remain keyed by project path.

Installed program backups live under `PREFIX/share/cx/backup-*/program`.
Use the [rollback instructions](INSTALL.md#rollback-and-portable-updates) to
restore matching program and image versions. Reverting code alone does not
undo history, project, environment or server changes made while running it.
