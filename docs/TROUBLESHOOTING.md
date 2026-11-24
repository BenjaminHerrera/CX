# Troubleshooting

[Handbook home](README.md) · [Command reference](USAGE.md#troubleshooting) · [Get help](../SUPPORT.md)

Start in your **host terminal**, outside CX:

```bash
cx --version
cx --doctor
docker info
python3 --version
```

`--doctor` reports paths and prerequisites without signing in or creating
account data. Interactive managed sessions need Python 3.11+; redirected tasks
do not. Shell commands typed inside a CX shell cannot fix host Docker access.

## Installation or Account Selection

| Symptom | Check |
|---|---|
| `cx: command not found` | Add `PREFIX/bin` to host PATH; default `~/.local/bin` |
| Docker unavailable | Start the local daemon; check host/WSL integration and `docker info` as your user |
| `adapter_permission`, `adapter_load`, `adapter_handshake` or `adapter_timeout` before SSH assistant launch | Read the bounded diagnostic, update the source and rebuild the image in either edition; use `--no-ssh-mcp` temporarily. See [MCP rebuild guidance](INSTALL.md#cx-13-mcp-adapter-rebuild-target-v212). Do not replay uncertain remote work. |
| Image missing or adapter incompatible | Build/rebuild the image from the updated checkout, then restart CX |
| GitHub CLI is missing or cannot authenticate | Rebuild the image and restart the assistant with a readable `CX_GH_TOKEN_FILE`. Check the credential with `gh api user --jq .login`. See [GitHub CLI access](ACCOUNTS.md#github-cli-access). |
| No profiles in the picker | Run `cx accounts list`; create a profile and log in explicitly |
| Noninteractive launch asks for an account | Supply both `--agent` and `--account`, or save an automation default |
| Sessions missing in legacy mode | An explicit `CX_CODEX_HOME` disables managed accounts and the menu |
| Sign-in changes affected the wrong account | Check the complete CLI/account pair used with `--login`, `--logout` or `--auth-status` |

Native `~/.codex` and `~/.claude` logins are not imported automatically. A
shared conversation can still be subject to native account ownership checks.
Host provider-key variables are not automatically passed into the container;
use the [account authentication flow](ACCOUNTS.md#authentication).

## Session Menu or Switching

| Symptom | What to do |
|---|---|
| Enter selected a row but nothing switched | Read the menu’s reason; finish tracked remote work or return from SSH focus with Ctrl-] c, then retry |
| Switch blocked in SSH mode | Return to assistant focus with Ctrl-] c and resolve authentication or unfinished remote work |
| Expected conversation absent | Clear search, change CLI/status filters, and use F2 for internal reviewer/subagent records |
| No active `*` on a new chat | Native/new identity is not guessed from recent activity; explicit UUID selection establishes known identity |
| Resume failed | Read the saved error, verify CLI/account access, then reopen Sessions; CX does not retry automatically |
| Claude removal blocked | Exit all managed Claude writers, including saved background sessions. Retry: dead leases recover after host PID and Docker checks. If still blocked, inspect stale leases or deletion gates before removing them manually |
| Import rejected SQLite history | Use the updated importer; complete paginated rollouts are supported. Read specific missing/truncated-file diagnostics |

See [Sessions](SESSIONS.md) for keys and deletion rules, and
[Import Native Sessions](IMPORTING.md) for deliberate skip/conflict options.

## Text Selection, Scrolling or Stray Input

The managed local and SSH screens use wheel capture. Hold **Shift while
dragging**, then copy with the terminal shortcut; in Windows Terminal that is
usually Ctrl+Shift+C. **Ctrl-] m** toggles capture for plain drag selection.
**Ctrl-] b** returns to live output from the saved history view.

For garbled output or unexpected terminal sequences, update the wrapper,
exit old CX sessions and restart. If the host display remains garbled, run
`reset` outside CX. Complete passwords and MFA directly in the SSH screen;
do the initial Ctrl-] c handoff only after reaching a Bash prompt. Report your
terminal application and local/SSH mode when filing an input/rendering issue.

## Paths, Environments and Remote Work

| Symptom | What to do |
|---|---|
| Cannot find the host project path in CX | Use `/workspace/main`; see the [path map](WORKSPACES.md#know-which-directory-you-are-using) |
| Individually mounted file cannot be replaced | Write in place or use `--add-dir` for its parent |
| Permission denied on a mount | Check host UID/GID ownership and rootless/remapped Docker configuration |
| Environment change did not affect PATH | Use `cx-env run -- COMMAND` now, or restart; check `CX_ENV_NAME` overrides |
| Environment disappeared after moving a project | Stores use the canonical absolute project path; recreate from an environment export |
| A program cannot run under `/tmp` | Assistant `/tmp` is `noexec`; keep executable tools in a named environment |
| SSHFS failed | Check host FUSE/SSHFS, server SFTP and `user_allow_other`; use an absolute remote directory |
| Remote file view disconnected | Restart CX; reconnecting the shell does not repair the mount |
| `cpu`/`gpu` never becomes ready | Check per-alias setup, shared storage, Bash startup hook and matching Slurm job ID/token |
| Ready allocation is on the login node | Inspect `hostname`; use the site's approved compute-shell launch method |

Never rerun remote work merely because it timed out. Poll the existing command
ID or inspect the original shell/job to establish its outcome first.

## Ask for Help

Use the [issue forms](https://github.com/BenjaminHerrera/CX/issues/new/choose).
Include the command, expected/actual result, CX/native CLI versions, host OS,
terminal and local/SSH/Slurm mode. Redact output. Do not attach account homes,
SSH keys, MFA codes, full portable data trees or unreviewed conversation files.


## Provider Connection Check

Use `cx test_connection` to distinguish CLI startup, authentication and
provider reachability for your managed profiles. Resolve a missing or ambiguous
profile with `cx accounts add` or `cx accounts default`. For credentials that
have expired, sign in to that profile again. See [connection check behavior](USAGE.md#test-both-provider-connections).
