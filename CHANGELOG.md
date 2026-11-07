# Changelog

## 1.1.0 — 2026-11-06

- Added optional host SSH sessions using existing SSH configuration, keys,
  agents, and interactive authentication/MFA. Terminal handoff preserves a
  remote Bash shell; `cx-remote` provides command execution and status.
- Added optional SSHFS browsing at `/workspace/remote`, read-only by default
  and writable with `--ssh-mount=rw`, while retaining remote command execution.
- Added repeatable `--add-file FILE` for individual local read/write mounts
  without exposing their parent directories. Files and added directories
  share collision-safe names; standalone files require in-place writes.
- Grouped project mounts under `/workspace/main`, `/workspace/cx-external`,
  and `/workspace/remote`. Sessions start at `/workspace`; non-interactive
  exec tasks skip the Git check for that parent directory.
- Added session instructions for the selected SSH host, remote directory,
  mount path/mode, terminal interaction, and individual-file limitations.
- Styled pre-SSH connection help to match the shell command references.
- Extended offline tests, Docker verification, and release packaging to cover
  the new helpers and mount options. Consolidated user and maintenance docs.

**Upgrade:** rebuild the image and restart sessions. Update scripts using
old container paths. Existing installed system configuration is preserved;
compare it with the new defaults. Credentials, environments, and host project
paths are unchanged. See [upgrade instructions](docs/INSTALL.md#upgrading-to-110).

## 1.0.0

Based on the externally supplied cx launcher, Dockerfile, cx-entrypoint,
cx-env, and cx-config/config.toml.

- Added a user installer, managed upgrades with backups, and an uninstaller.
- Added a relocatable portable launcher with private data storage.
- Replaced hardcoded build/configuration paths with package-relative paths.
- Added `--build`, `--doctor`, and `--version`; help works without Docker.
- Made terminal allocation conditional so piped `exec` commands can run.
- Applied root and credential overlap checks to shell and normal workspaces.
- Made ignored directory mounts explicitly read-only.
- Added documentation, release archives/checksums, and offline regression tests.
- Added a real Docker verification script for both extracted editions.
- Kept source maintenance tools out of installed runtime folders.

The supplied container dependency versions, environment selection behavior,
and persistent-package approval instructions are retained. The original
external files were used as input and were not modified.
