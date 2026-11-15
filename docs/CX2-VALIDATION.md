# CX-2 Integration Validation

Implementation branch starts at origin/v2 9382e67. No merge or release is authorized.

Both CLIs share the existing SSH supervisor, socket, MCP adapter and Slurm hook.
Host agent adapters own CLI-specific launch overrides and reserved-name checks.
Claude receives current host/path/mount guidance on each launch, including resume;
its prompt snapshots remain disabled. Registration uses session-only --mcp-config,
without editing account or project settings. --no-ssh-mcp retains cx-remote guidance.

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
