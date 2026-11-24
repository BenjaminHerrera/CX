# SSH and Remote Files

[Handbook home](README.md) · [Slurm setup](SLURM.md) · [SSH reference](USAGE.md#work-through-ssh)

CX's assistant runs locally in Docker. Optional SSH mode connects its commands
to a Bash shell on your server. It uses host OpenSSH configuration and keeps
the remote shell state between commands.

## Connect with an Existing Alias

First verify that ordinary `ssh my-server` works from your host. SSH mode needs
OpenSSH and Python 3.11+ on that host, an interactive terminal, and remote Bash.
Then run from the host:

```bash
cx /path/to/local/project --ssh my-server --remote-dir /remote/projects/app
```

`my-server` is your existing SSH alias. Keys, jump hosts, agents and known-host
checks stay with host OpenSSH. CX does not copy SSH credentials into Docker.
`--remote-dir` is optional; use an absolute remote path instead of `~`.
The project argument still selects a **local** directory.

1. Complete SSH password, key passphrase, host-key confirmation and MFA directly.
2. Wait for the remote Bash prompt.
3. Press **Ctrl-]**, release it, then **c** to initialize the bridge and start
   the selected assistant.

Do the first handoff only at a Bash prompt. Afterwards, switching saved screens
does not type setup text into a password prompt or shell.

## Shortcut Help

The green SSH header reads `SSH  --  Ctrl-] ?: Help Menu`. Assistant headers
use the same format with their CLI/account, such as `CLAUDE/work`. Press
**Ctrl-]**, release it, then **?** for the full reference, including terminal
switching, Sessions, wheel capture, Shift-drag selection and literal Ctrl-].
Unavailable local/legacy controls are labeled. Esc restores the prior pane,
scroll position and focus. Help is safe during login/MFA, active commands or
disconnection: opening it sends no input and never reconnects or replays work.
Temporary status and history offsets use a separate footer; the help hint stays
in the header. Use arrows, Page keys or the wheel to scroll help.

## Navigate the Screens

| Shortcut | Action |
|---|---|
| Ctrl-] ? | Open Help Menu; Esc restores the previous view |
| Ctrl-] r | Show the SSH terminal |
| Ctrl-] c | Show the assistant; initialize it on the first handoff |
| Ctrl-] s | Open Sessions |
| Ctrl-] b | Return from saved terminal history to live output |
| Ctrl-] m | Toggle wheel capture versus plain drag selection |
| Ctrl-] q | Exit CX |
| Ctrl-] Ctrl-] | Send a literal Ctrl-] to the selected terminal |

The SSH bar is green. Assistant and Sessions screens are blue. Output stays
on its own saved screen; switching does not paste SSH output over the chat.
Wheel scrolling follows the active application or its saved terminal history.
Hold Shift while dragging to select text, then use your terminal's copy shortcut
(usually Ctrl+Shift+C in Windows Terminal). Ctrl-] m allows plain dragging when
wheel capture is off. Managed interactive local sessions use the same renderer.

## Let the Assistant Use the Remote Shell

Before registering `cx_ssh`, CX checks the installed adapter as the assistant
UID/GID with a bounded initialize/tools-list exchange. This check is isolated
from credentials and the SSH bridge; success means the adapter starts, not that
SSH is connected. Missing, unreadable, unloadable or incompatible adapter errors
include rebuild guidance and bounded stderr. The CX-13 permission fix needs an
[image rebuild in either edition](INSTALL.md#cx-13-mcp-adapter-rebuild-target-v212).

MCP registers `cx_ssh` for the selected CLI automatically. For example, ask:

> Check the remote working directory and Git status. Report what you find.

The assistant can use tracked remote tools or the container's `cx-remote`
client. For manual use **inside the container**, examples include:

```bash
cx-remote status
cx-remote exec 'pwd'
cx-remote exec 'git status --short'
```

Only one command owns remote input at a time. Switch to SSH for authentication
or direct interaction; return to the assistant when finished. After a timeout
or disconnect, poll the existing command ID or inspect the result. Do not rerun
work with an unknown outcome. [Remote tools](USAGE.md#ssh-mcp-tools) lists the
full MCP and command-line interfaces. `--no-ssh-mcp` keeps CLI/manual operation
when automatic MCP is intentionally disabled.

## Browse Files Without Repeated Remote Commands

Add a read-only SSHFS view:

```bash
cx /path/to/local/project --ssh my-server \
  --remote-dir /remote/projects/app --ssh-mount
```

The assistant can read `/workspace/remote` using normal container file tools.
For writes to server files, opt in explicitly with `--ssh-mount=rw`.

Mounting needs host SSHFS/FUSE, `fusermount3` or `fusermount`, server SFTP, and
the host FUSE permissions described in [Installation](INSTALL.md#optional-ssh-prerequisites).
A read-only mount does not make remote shell commands read-only.

The mount stays attached to the initial login host/path. It does not follow a
`cd`, a compute allocation or a shell reconnection. Restart CX if the filesystem
view disconnects. Use [Slurm Setup](SLURM.md) for CPU/GPU sessions and
[Troubleshooting](TROUBLESHOOTING.md) for handoff, mount and input problems.


For GitHub operations from the local assistant container in SSH mode, set
`CX_GH_TOKEN_FILE` on the host when launching CX. The remote login shell
receives none of this credential. See [GitHub CLI access](ACCOUNTS.md#github-cli-access).
