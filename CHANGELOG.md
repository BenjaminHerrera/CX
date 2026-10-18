# Changelog

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
