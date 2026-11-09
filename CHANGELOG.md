# Changelog

## 1.1.4 — 2026-11-08

- Restore wheel scrolling in SSH mode. Route wheel events to mouse-aware
  applications or browse up to 2,000 saved terminal lines per normal/alternate
  screen, including output moved by explicit scroll commands. Keep history
  positions across session switches and new output.
- Enable wheel capture by default. Hold Shift while dragging to select text;
  Ctrl-] m toggles capture for plain dragging. Ctrl-] b or typing returns from
  renderer history to the live view. Clicks and drags never enter child PTYs.
- Preserve dim placeholder text, shaded prompt backgrounds, underline styles
  and colors, hidden/overlined text, and existing bold/italic/reverse styles.
  Keep indexed colors as terminal palette references and retain RGB colors.
- Cache startup terminal theme replies for application color queries without
  injecting responses into authentication or chat input. Forward the host's
  COLORTERM capability to containers. Vendor sources remain unchanged.
- Add wheel routing/encoding, history isolation/pinning, style round-trip,
  theme-reply isolation, and independent native-terminal regression checks.

**Upgrade from 1.1.0–1.1.3:** run `./install.sh --no-build` on the host
and restart SSH-mode sessions. The existing 1.1.0 image remains compatible.
Selection now uses Shift-drag while wheel capture is on. See
[upgrade instructions](docs/INSTALL.md#upgrading-to-114).

## 1.1.3 — 2026-11-08

- Keep native drag-to-select available in SSH mode, including after switching
  sessions. Disable application mouse capture and discard late mouse reports
  so they cannot enter password fields or prompts.
- Report mouse modes as disabled to both applications. Local sessions
  without `--ssh` retain their usual mouse behavior.
- Document Windows Terminal copying, the Shift-drag workaround for older
  sessions, and the application mouse-control limitation. Add regression
  tests for repeated switching, mouse-mode queries, and late reports.

**Upgrade from 1.1.0–1.1.2:** run `./install.sh --no-build` on the host
and restart SSH-mode sessions. The existing 1.1.0 image remains compatible.
See [upgrade instructions](docs/INSTALL.md#upgrading-to-114).

## 1.1.2 — 2026-11-08

- Give SSH and Codex independent saved terminal screens, cursors, alternate
  buffers, and scroll regions. Background output updates only its own screen;
  switching redraws current content instead of replaying raw output.
- Add a persistent full-width top bar: green for SSH and blue for CODEX.
  Notices stay in the reserved row and applications cannot clear or scroll
  over it. Application PTYs receive the remaining window height.
- Answer terminal display queries against each session's virtual screen,
  and preserve content across resizing.
- Add Ctrl-] q to exit an SSH-mode session while retaining Ctrl-] r/c for
  switching. Restore the enclosing terminal screen when cx exits.
- Bundle unmodified pure Python pyte/wcwidth sources and licenses. No tmux or
  host Python package installation is required for SSH mode.
- Add screen-isolation, color, Unicode, alternate-buffer, resize, and independent
  native-terminal checks. tmux is used only as an optional test terminal.

**Upgrade from 1.1.x:** run `./install.sh --no-build` and restart SSH-mode
sessions. The 1.1.0 image remains compatible; older installations still need
the workspace/image migration. See [upgrade instructions](docs/INSTALL.md#upgrading-to-114).

## 1.1.1 — 2026-11-08

- Fixed Ctrl-] r sending `stty echo` into password/MFA or other interactive
  input. Switching between established terminals now changes input routing
  without typing commands into either application.
- Route terminal query replies back to their requesting PTY, buffer split
  escape sequences, and discard unsolicited/stale reports. Restore common
  input modes per terminal, including Windows Terminal and enhanced keyboard
  modes, so delayed replies and key releases do not become prompt text.
- Preserve bracketed paste and the original remote TTY settings, hide internal
  command framing from output, and initialize PTY dimensions before launch.
- Added authentication, terminal-response, keyboard-release, paste, Unicode,
  and Windows Terminal protocol regression tests. Real Windows Terminal,
  live SSH/MFA, and Docker validation still require host testing.

**Upgrade from 1.1.0:** run `./install.sh --no-build` from this release and
restart all SSH-mode cx sessions. This release changes host-side supervision;
the 1.1.0 container image remains compatible. Credentials, configuration,
project paths, and environment stores are preserved. Older installations
still need the 1.1.0 image/layout migration. See
[upgrade instructions](docs/INSTALL.md#upgrading-to-114).

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
paths are unchanged. See [upgrade instructions](docs/INSTALL.md#workspace-migration-from-10x).

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
