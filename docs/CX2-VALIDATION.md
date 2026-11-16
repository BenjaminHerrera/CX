# CX-2 Integration Validation

Historical validation record for the implementation that started at
`origin/v2` `9382e67`. It is now integrated into `main` through
[PR #9](https://github.com/BenjaminHerrera/CX/pull/9). Use the
[handbook](README.md) for current instructions. Checks and skips below are
implementation-time evidence, not a new verification of every live platform.

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

The follow-up option regressions cover `--name`, `-n`, `--agents`, equals forms,
optional/variadic native values, options after a prompt, and the literal `--`
boundary. Validation uses the installed CLI's help declarations to determine
arity; unrecognized options produce a clear error instead of skipping checks.
Use the long option spelling, rebuild, or explicitly choose `--no-ssh-mcp` if
an option's arity cannot be determined. Claude's `--name`/`--agents` options also
preserve cx `exec` translation.

Latest review-fix validation: `node tests/accounts.mjs` (20 checks),
`node tests/smoke.mjs` (25 checks, both extracted editions), shell/Node syntax
and `git diff --check`. Five additional checker reproductions passed with help
from the installed Claude binary, without model requests. The 60 SSH bridge
tests passed on the prior review fix; transport code is unchanged here. These
are offline checks, not live Docker mount or provider validation.

## Open Live Gates

- Docker rebuild and installed/portable runtime tests of the integrated code.
- Consenting Claude and Codex SSH/MCP sessions, manual authentication, SSHFS ro/rw,
  terminal scrolling, selection, paste, styles, resize and restoration.
- Explicitly authorized live CPU/GPU allocations for both agents: readiness token,
  job ID, physical hostname, command output/status, close and scheduler cleanup.
- Automatic credential refresh. API-key and second-Claude-account tests remain
  skipped under the user's previously recorded constraints; no live pass is claimed.
- Windows Terminal verification on a real Windows/WSL host.

Offline fixtures do not close these gates. The integration has since merged;
the skipped live checks remain limitations until separately verified and recorded.
