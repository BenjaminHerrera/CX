# CX-2 Integration Validation

Implementation branch starts at origin/v2 9382e67. No merge or release is authorized.

Both CLIs share the existing SSH supervisor, socket, MCP adapter and Slurm hook.
Host agent adapters own CLI-specific launch overrides. Claude reserved-name checks
run inside the container against mounted configuration, including absolute paths
and ignore masks. Only the current working directory’s native project entry in
the account config is active; unrelated saved project entries do not block launch.
Claude receives current host/path/mount guidance on each launch, including resume;
its prompt snapshots remain disabled. Registration uses session-only --mcp-config,
without editing account or project settings. --no-ssh-mcp retains cx-remote guidance.

The review regressions cover container-visible absolute config paths, single-value
`--settings` before `exec README.md`, inactive project entries, active user/project
conflicts, unrelated MCP servers and opt-out. Rebuild images after this update
(the Claude SSH image capability is now `io.cx.ssh-agents=2`).

Review-fix validation: `node tests/accounts.mjs` (19 checks),
`node tests/smoke.mjs` (25 checks, both extracted editions), and
`python3 -B tests/ssh_bridge.py` (60 tests) passed, along with shell syntax,
Node syntax and `git diff --check`. These are offline fixtures, not live Docker
mount or provider validation.

## Open Live Gates

- Docker rebuild and installed/portable runtime tests of the integrated code.
- Consenting Claude and Codex SSH/MCP sessions, manual authentication, SSHFS ro/rw,
  terminal scrolling, selection, paste, styles, resize and restoration.
- Explicitly authorized live CPU/GPU allocations for both agents: readiness token,
  job ID, physical hostname, command output/status, close and scheduler cleanup.
- Automatic credential refresh. API-key and second-Claude-account tests remain
  skipped under the user's previously recorded constraints; no live pass is claimed.
- Windows Terminal verification on a real Windows/WSL host.

Offline fixtures do not close these gates. Do not merge into v2 or main without
explicit user approval. Final v2-to-main integration requires a separate review.
