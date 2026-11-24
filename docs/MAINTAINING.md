# Maintenance and verification

The v2 integration is on `main`. This guide describes validation and packaging
for current work; implementation-time records remain in the handbook's
[validation section](README.md#validation-and-versions).

Start with the [development guide](DEVELOPMENT.md) for local setup and component
workflows. See [GitHub maintenance](GITHUB.md) for triage, repository settings,
and the release checklist. The [documentation index](README.md) lists all guides.

The launcher is Bash; interactive supervision and the SSH bridge use Python 3.11+ standard
library modules plus bundled pure Python pyte/wcwidth sources for screen
rendering. The container client and wrapper tests use Node.js built-in
modules. The MCP suite requires the locked SDK dependencies; other suites need no npm dependencies.
Host Node.js is needed for maintenance, not ordinary cx use. Host Python is
required for managed interactive sessions, SSH mode and their tests.

## Offline checks

Run from the repository or an extracted release. Installed program folders
contain runtime code and documentation, while tests and maintenance scripts
remain in the source distribution.

```bash
node tests/smoke.mjs
node scripts/docs.mjs --check
node tests/accounts.mjs
node tests/sessions.mjs
node tests/session-menu.mjs
python3 -B tests/session_menu.py
node tests/import-sessions.mjs
node tests/remote-client.mjs
npm ci --prefix container/mcp --ignore-scripts
node tests/mcp.mjs
node tests/mcp-preflight.mjs
python3 -B tests/ssh_bridge.py
python3 -B tests/slurm_setup.py
python3 -B tests/screens.py
```

| Suite | Coverage |
|---|---|
| `scripts/docs.mjs --check` | Canonical handbook source inventory, local Markdown targets/anchors; wiki generation is also checked in CI and both extracted editions |
| `import-sessions.mjs` | Copy-only native history migration, dry run, independent copies, archive/compression deduplication, conflicts, metadata merge, SQLite/WAL and missing/truncated rollout checks; opt-in native discovery and paginated resume |
| `sessions.mjs` | Exact-ID removal, CLI collisions, transcript/index preservation, symlink refusal and native error handling; opt-in native Codex fixtures cover archives, descendants and SQLite cleanup |
| `smoke.mjs` | Shell syntax, Docker argument generation, workspace layout, file/directory mounts, masking, piped tasks, credential/path rejection, install/upgrade/removal, environments, packaging, and extracted editions |
| `screens.py` | Saved screen isolation, full-width bars, normal/alternate scrollback, pinned history, resize, Unicode, dim text and background shading, indexed/RGB colors, underline styles, standalone imports, and optional native VT tests |
| `slurm_setup.py` | Fake SSH server setup, separate aliases, paths with spaces, job-ID patterns, idempotence, hook discovery, configuration privacy, and refusal of unmanaged hooks |
| `remote-client.mjs` | Command transport, quoting, streamed output, and returned exit status |
| `mcp-preflight.mjs` | Real source adapter initialization, simulated status, unreadable/missing code, loader/protocol failures, bounded diagnostics and timeout; no installed-image claims |
| `mcp.mjs` | SDK discovery, input validation, structured results, command routing, and adapter restarts |
| `ssh_bridge.py` | Real PTYs with fake SSH, persistent shell state, framing, terminal handoff, resizing/restoration, manual input exclusion, terminal-reply ownership, Windows/enhanced keyboard modes, paste, wheel routing/encoding, capture toggle, history controls, theme reply isolation, TTY restoration, and mocked SSHFS setup/cleanup/instructions |

The suites use temporary fixtures, never sign in, and never send model
requests. The wrapper suite uses fake Docker. The SSH suite requires Linux
PTYs and Python 3.11+; it mocks FUSE operations. Passing these tests does not
establish live Docker, SFTP, SSHFS, or authentication compatibility.

## Native CLI Account Compatibility

Use `CX_NATIVE_HISTORY=1 CX_NATIVE_CLAUDE=/path/to/claude node tests/native-history.mjs`
for real native storage, selected-auth resume and concurrent distinct conversation
checks against a loopback simulator. This suite does not establish live account
login, provider compatibility or Docker mount behavior. See [account verification
and open gates](ACCOUNTS.md#verification-and-open-gates). Recheck compatible CLI
versions when changing either version override or storage topology.

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

1. Start a managed interactive SSH session with a configured alias and
   `--remote-dir`. Complete login/MFA and any Bash startup prompts. Confirm
   Sessions opens without a shortcut. With a disposable empty history, confirm
   CX starts the selected assistant instead. Dismiss the initial menu and press
   Ctrl-] c to check the manual launch path. Check `cx-remote status` and
   confirm that a directory change persists when you start a nested `bash -i`.
2. Switch with Ctrl-] r and Ctrl-] c. Confirm each saved screen restores
   without the other session's text, the full-width bar changes green/blue,
   and the bar survives clear-screen commands, alternate buffers, and resizing. Repeat Ctrl-] r at a password/MFA
   prompt and confirm no extra text is submitted. Check Windows Terminal/WSL
   separately, including focus changes, delayed terminal replies, enhanced
   keyboard key releases, Unicode, and bracketed paste. Check resizing,
   interruption, and reconnection. Disconnected commands must not be replayed.
   Scroll Codex chat history with the wheel, check Shift-drag and Ctrl+Shift+C,
   and toggle Ctrl-] m for plain drag selection. Confirm Ctrl-] b returns to
   live output and streaming output does not snap saved history back. Compare
   dim placeholder text, prompt backgrounds, indexed colors, and text styles
   against a local session using the same Windows Terminal theme.
3. Start with `--ssh-mount` and inspect `/workspace/remote`. Confirm reads
   succeed and writes through the mount fail. Confirm remote command execution
   still works.
4. Repeat with `--ssh-mount=rw`, write a disposable file through the mount,
   and verify its contents on the server. Exit and confirm the owned SSHFS
   mount is gone. Exercise mount failure and busy-unmount recovery separately.
5. For each Slurm site, use an authorized small CPU and GPU allocation to
   check readiness, `hostname`, command output and exit status, persistent shell
   state, and close/cleanup. Check Delta MFA on Delta itself. The mount stays
   on the configured SSH host; it does not follow compute nodes.

The 1.2.1 checks include the wrapper, bridge, screen-rendering, and client
suites. The screen suite additionally runs independent native VT checks when
tmux is present in the test environment; otherwise those checks are skipped.
tmux is never required to run cx. The offline tests do not use a live SSH
account or send a model request. Windows Terminal input records are tested as protocol
fixtures, not through a live Windows Terminal application. Live
Windows Terminal/WSL sessions, Docker builds and bind mounts, SSHFS/FUSE,
real sign-in, and Delta MFA remain unverified in the supplied environment.

## Build shareable archives

Update `VERSION`, the changelog, and release-specific documentation first:

```bash
./scripts/package.sh
cd dist
sha256sum -c SHA256SUMS
```

For version 2.2.0 the outputs are:

```text
dist/
├── cx-2.2.0-install.tar.gz
├── cx-2.2.0-portable.tar.gz
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
one on their behalf. Container components retain their upstream licenses. The bundled renderer
libraries retain their own licenses and replaceable source copies. See
[third-party notices](../bin/vendor/README.md); retain every listed source and
license file when updating or packaging them. The screen suite verifies that
the renderer imports with site packages disabled.

Terminal protocol references used for input routing:

- [Microsoft console virtual terminal sequences](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences)
- [Windows Terminal input mode specification](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)
- [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
- [Enhanced keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)

MCP verification: use the SDK client against the real adapter, plus bridge
PTY tests for tracked output and cancellation. Verify discovery in a rebuilt
Docker image and a live Codex SSH session. Check --no-ssh-mcp, a missing adapter,
reserved-name conflicts, adapter restart/polling, output truncation, and unknown
outcomes after disconnect. Release archives contain adapter sources and
lockfile, never node_modules; run npm ci for source MCP tests.

Interactive-session checks use a fake allocator and real PTY plus unit tests
for token/job matching, fragmented frames, manual-focus gating, nested shell
state, output, return codes, cancellation, and disconnect. Validate GNU screen
attachment and Slurm with a small explicitly authorized allocation on-site;
the simulator cannot prove site-specific timing or authentication behavior.
On 2026-11-09, live Alpine `sinteractive` CPU and A100 MIG GPU tests reached
compute nodes through the MCP bridge, ran commands, and closed both jobs; the
CPU test also confirmed shell state persists across commands. The scheduler
showed neither job remaining afterward. Other sites and allocation modes
still need their own checks.


Named-session release checks are recorded in [CX-7 validation](CX7-VALIDATION.md).
Menu fixtures and native Codex naming checks do not establish live Docker, SSH
handoff, Windows Terminal selection/paste, or scheduler compatibility. Confirm
fresh guidance and native ownership failures on an integrated host before release.
Claude writer leases cover interactive supervision and managed exec/print launches;
inspect stale leases/gates only with the related writers and maintenance stopped.

## CX-18 GitHub CLI Validation

The maintainer confirmed Docker verification and live GitHub authentication
for the GitHub CLI change in PR #19. The Docker verifier checks `gh` availability
in both packaged editions. The live authentication check confirms the token
works against GitHub. For setup and the authentication command, see
[GitHub CLI access](ACCOUNTS.md#github-cli-access) and
[PR #19](https://github.com/BenjaminHerrera/CX/pull/19).

## CX-18 SSH Handoff and Connection Check Validation

[PR #20](https://github.com/BenjaminHerrera/CX/pull/20) merged into `main` as
`94a3970`. Its final review passed 69 SSH bridge tests, 41 Sessions menu tests,
documentation checks, and [GitHub CI](https://github.com/BenjaminHerrera/CX/actions/runs/45327103195/job/138219219653).
The simulated SSH tests cover login and startup prompts, automatic menu and
assistant launch, manual fallback, and keeping the current directory in nested
Bash. The native connection fixture used Codex 0.172.0 and Claude Code 2.1.323
against loopback providers. Repeated probes preserved fixture history, and a
provider rejection produced a redacted error.

The automated checks above used simulated SSH and loopback providers. For
repeatable host checks, follow the [live SSH checklist](#live-ssh-and-mount-verification)
and run [the provider check](USAGE.md#test-both-provider-connections).
Verify that Sessions has the same entries before and after the provider check.
The owner's subsequent integration-test confirmation is recorded below.

## CX-18 Watcher and Session Maintenance Validation

[PR #21](https://github.com/BenjaminHerrera/CX/pull/21) completes the `cx-watch`
workstream from [CX-18](https://github.com/BenjaminHerrera/CX/issues/18), following
the GitHub CLI work in PR #19 and SSH/connection checks in PR #20. It also fixes
Codex menu deletion using an inconsistent history home, recovers confirmed
stale Claude writer leases on the host, and adds watcher guidance to both CLIs.

The owner reported that the requested test passed and explicitly authorized
merging PR #21 and closing CX-18. This is owner-confirmed validation; raw host
output was not supplied, and Docker/live SSH were not rerun in the development
container.

Automated coverage includes watcher sources, state/restarts, CI reruns on an
unchanged head, and independent batch SSH for configured aliases. Native Codex
0.172.0 fixtures verify active and archived chat deletion after a fresh helper
launch, SQLite cleanup, and preservation of unrelated conversations. Host-side
lease tests retain markers for active PIDs, overlapping writable containers,
unknown states, malformed/symlinked records, and failed Docker inspection.
Launcher/package tests cover both extracted editions; prompt tests cover
Claude startup and Codex/Claude SSH launches with preserved older settings.

For upgrades, rebuild the image and start a new CX session. Local Codex users
retaining an older configuration should merge the watcher paragraph into
`developer_instructions`; SSH launches append it automatically. See
[Watch for Changes](WATCH.md) and [session maintenance](ACCOUNTS.md#remove-a-session).

## CX-13 Validation (Target v2.1.2)

The fix merged into `main` in [PR #14](https://github.com/BenjaminHerrera/CX/pull/14)
(merge commit `223570a`). It normalizes public MCP runtime permissions during
the image build and checks installed startup under the session UID/GID.
Existing images need a rebuild; source-file chmod alone does not fix an already
built image. See
[rebuild instructions](INSTALL.md#cx-13-mcp-adapter-rebuild-target-v212) and
[probe development](DEVELOPMENT.md#mcp-image-startup-checks).

**Docker verification: passed (owner-confirmed).** The owner confirmed that
`./scripts/verify-mcp-image.sh --build` passed after PR review, satisfying the
Docker image and packaged-startup verification gate for CX-13. The recorded
Docker-host run used Codex 0.171.0 and Claude Code 2.1.323.

The passing script covers:

- A disposable image built from MCP sources forced to 0600 initialized and
  discovered tools as UID/GID 23456; `ssh_status` succeeded against the simulated
  bridge for both CLI configurations. The verifier also checked root ownership,
  readability and lack of write access to installed runtime files.
- Deliberately unreadable and unloadable installed adapters produced the expected
  `adapter_permission` and `adapter_load` failures.
- Install and portable editions both passed the session-user startup preflight
  and native `--version` launch for both CLIs.

Local review also passed the existing MCP suite, seven preflight checks, 25
smoke/install/package checks, remote-client checks, documentation and syntax
checks. GitHub's Offline checks passed. The review container could not rerun
Docker, and its account suite stopped because host Python 3 was unavailable;
those review limitations are separate from the confirmed Docker-host result.

The Docker test packages reported CX 2.1.1 with the CX-13 fix applied.
For v2.1.2, `CX_NATIVE_MCP=1 node tests/native-history.mjs` passed with Codex
0.171.0 and Claude Code 2.1.323. Both native clients advertised `ssh_status`
to a loopback model simulator, called the actual source adapter, and returned
the simulated Unix-socket bridge's response. Each client sent exactly one
status request. The fixture uses disposable homes and synthetic API keys.
Provider authentication and live SSH execution remain unverified for CX-13.
