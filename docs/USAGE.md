# Usage and configuration

Examples below use an installed `cx`. For portable use, replace it with the
absolute path to the bundle's `cx` file. Paths containing spaces are supported;
quote them. Paths used in Docker mounts cannot contain commas.

## Start a session

```bash
cx /path/to/project
cd /path/to/project
cx .
cx . exec "Explain the test failures"
printf '%s\n' 'Summarize this repository' | cx . exec -
```

The optional first directory selects the local project. cx handles its own
commands, `--add-dir`, `--add-file`, and SSH options; other arguments pass to
Codex. Use an explicit project directory if a Codex argument could also name
an existing directory. Paths in prompts and other Codex arguments are not
translated automatically: use the appropriate `/workspace/main`,
`/workspace/cx-external`, or `/workspace/remote` container path.

Docker gets a terminal only when stdin and stdout are terminals. Redirected
`exec` commands work without `-t`. The container's exit status is returned to
your shell. Container files outside the mounts and persistent environment store
are discarded when the process exits.

## Workspace directory layout

Both Codex sessions and `cx --shell` start at `/workspace`:

```text
/workspace/
├── main/          # the local directory selected by cx
├── cx-external/   # extra local directories and files
└── remote/        # optional SSHFS view from --ssh-mount
```

For `cx ~/projects/app`, the contents of `~/projects/app` appear directly
inside `/workspace/main`. These are container mount locations; cx does not
create these three folders inside your local project. `ls -al` at startup
shows all three. `cx-external` and `remote` remain empty when unused.

Use `cd main` for local project commands, `cd cx-external/NAME` for an added
directory, or `cd remote` to browse a mounted SSH project. The `/workspace`
parent and unused placeholders are read-only; create project files in the
mounted directories. Remote command execution continues to use server paths.
`cx ... exec` automatically adds `--skip-git-repo-check`, because the browser
parent is above the selected project repository.

After upgrading, rebuild the image to create this layout. Update scripts that
previously used `/workspace/FILE`, `/cx-external/NAME`, or `/remote/FILE` to
`/workspace/main/FILE`, `/workspace/cx-external/NAME`, or
`/workspace/remote/FILE`, respectively. Host paths and CLI directory arguments
are unchanged.

## Extra directories

```bash
cx /projects/app --add-dir ../shared --add-dir /datasets/current
cd /projects/app
cx --shell --add-dir ../shared
```

Relative paths resolve from the primary workspace. A subdirectory of that
workspace stays at `/workspace/main/subdirectory`. An external directory
becomes `/workspace/cx-external/BASENAME`; name collisions get `-2`, `-3`, etc.
These mounts are writable and changes affect the host immediately. `--add-dir` cannot expose
`/`, an ancestor of the workspace, or the credential directory and its
ancestors/children.

`cx --shell` uses the current directory as its workspace and accepts
`--add-dir` and `--add-file` options. It starts Bash after environment setup.
`exit` leaves it.
The shell has the same project, credentials, and environment mounts; it does
not run Codex or load the Codex system instructions.

## Add individual files

Use repeatable `--add-file FILE` options to share existing regular local files
read/write without exposing the rest of their parent directory:

```bash
cx ~/projects/app --add-file ~/notes.md --add-file ../settings.json
cx ~/projects/app --add-file=/path/to/report.txt
cd ~/projects/app
cx --shell --add-file ~/notes.md
```

Relative paths resolve from the selected local project, just like `--add-dir`.
Files outside the project appear at `/workspace/cx-external/FILENAME`, with
spaces and other unsupported filename characters replaced by underscores.
File and directory name collisions share the same `-2`, `-3`, etc. suffixes.
Repeated references to the same canonical file are mounted once. Symbolic
links resolve to their target file, including its target filename. Files
already inside the project remain at `/workspace/main/...`; their existing
`.codexignore` masks are retained.

The source must already exist and be a readable, writable regular file.
Create a new file on the host first if necessary. Missing files, directories,
special files, and files in the Codex credential directory (including through
symlinks) are rejected. Docker mount paths cannot contain commas.

Edits affect the host file immediately. Because an individual file is a Docker
bind mount, edit its contents **in place**. Tools that save by renaming a
replacement over the mounted file, or that delete it, can fail with a busy
mountpoint error. If that happens, write the new contents into the existing
file instead. To support ordinary rename-based saves or creating sibling files,
share the containing directory with `--add-dir` instead. Replacing the host
file by rename during a running session can leave the mount attached to the
old file; restart cx to pick up the replacement.

Standalone external file mounts are explicit grants: `.codexignore` overlays
from other directory mounts do not mask these additional file aliases.
`--add-file` always refers to a local host file, including during SSH sessions;
remote files remain accessible through the optional remote mount or
`cx-remote exec`.

## Hide specific project paths

Create a `.codexignore` in the primary or added directory:

```text
# Literal paths relative to this directory
.env
secrets
build/private-report.txt
```

Each existing file is overlaid with an empty read-only bind mount. Each
existing directory is overlaid with an empty read-only tmpfs. The ignore file
itself is also hidden. Filenames remain visible. This is a mount overlay list,
not `.gitignore`: it has no globs, negations, or recursive matching. Blank
lines and lines starting with `#` are ignored; spaces in paths are significant.
Paths containing `..` segments or leading `/` are rejected.

Use direct, ordinary files and directories for these entries. Symbolic links,
hard links, alternate mounts, or a separately added directory can provide
other paths to the same data. Missing entries are not mounted; files created
at those paths during the session will be visible. Prefer keeping secrets
outside shared directories. See [the access model](ARCHITECTURE.md).

## Choose persistent development environments

Inside `cx --shell` or a Codex session, the helper is named **cx-env**:

```bash
cx-env active
cx-env list
cx-env path
```

Each canonical primary workspace path gets its own Micromamba root, mounted
at `/cx-env`. The default environment name is `default`; the name can be
selected before an environment exists. Creation is explicit:

```bash
# Inside the container; downloads packages into this workspace's store.
micromamba create -y -n tools -c conda-forge python=3.12
cx-env use tools
cx-env run -- python --version
```

`cx-env use` changes the selection for future container sessions. It cannot
change the parent shell's PATH. `cx-env run -- COMMAND` uses the newly selected
environment in the current session. After restarting cx, its entrypoint adds
the selected environment's `bin` directory to PATH automatically.

You can temporarily select an environment from the host:

```bash
CX_ENV_NAME=tools cx /path/to/project
```

An explicit override takes priority for that session even if `cx-env use`
changes the saved selection. Names must be 1–64 ASCII letters, digits, `.`,
`_`, or `-`, start with a letter or digit, and must not be `base`.

The container exports `CX_ENV_NAME`, `CX_ENV_PREFIX`, and `CX_ENV_AVAILABLE`.
If the selected environment is absent, it reports `false`; it does not create
an environment automatically. Use named environments for package installation.
System directories are read-only, and `/tmp` in Codex sessions is `noexec`.
Put executable tools in a named environment rather than `/tmp`.

The included developer instructions ask the agent to explain persistent
package changes and obtain approval unless you explicitly requested those
changes. This is an instruction to the agent, not an enforced package-manager
permission gate. A human running shell commands controls those changes directly.

## Settings

| Variable | Default for installed cx | Meaning |
|---|---|---|
| `CX_IMAGE` | `local/codex-isolated:latest` | Image to build and run |
| `CX_CODEX_VERSION` | `latest` | npm package version for builds only |
| `CX_CODEX_HOME` | `~/.codex` | Writable Codex credentials, settings, and session data |
| `CX_ENV_HOME` | `~/.local/share/cx/environments` | Workspace environment stores |
| `CX_ENV_NAME` | Saved selection, else `default` | Session environment override |
| `CX_CONFIG_DIR` | Package `config/` | Directory containing system `config.toml` |
| `CX_SLURM_CONFIG` | `$XDG_CONFIG_HOME/cx/slurm-servers.json`, else `~/.config/cx/slurm-servers.json` | Host file holding shared directories keyed by SSH alias |
| `CX_MEMORY` | `8g` | Normal Codex container memory limit |
| `CX_CPUS` | `4` | Normal Codex container CPU limit |
| `CX_PIDS` | `1024` | Normal Codex container process limit |

Portable defaults for `CX_CODEX_HOME` and `CX_ENV_HOME` are `data/codex` and
`data/environments` under the bundle. Explicit variables override these defaults.
Use absolute paths for directory overrides. Shell and login utility containers
retain their original behavior and do not apply the three resource limits.

```bash
CX_MEMORY=4g CX_CPUS=2 cx /path/to/project
CX_CODEX_HOME="$HOME/.codex-cx" cx --login
CX_CODEX_HOME="$HOME/.codex-cx" cx /path/to/project
```

Environment storage may not overlap the primary workspace or credentials.
The workspace may not overlap credentials. Do not put a portable bundle inside
your project or use your entire home directory as the workspace.

Persistent Codex preferences belong in the active credential store's
`config.toml`. For example:

```toml
# ~/.codex/config.toml for the default installed edition
model = "YOUR_MODEL"
```

Replace the placeholder with a model your account supports. For portable use,
edit `data/codex/config.toml`. The package's separate `config/config.toml` is
mounted at `/etc/codex/config.toml` during Codex workspace runs and provides the
persistent environment instructions. Installed configuration is stored at
`PREFIX/share/cx/config/config.toml` and is preserved across upgrades.

CLI overrides, trusted project configuration, and user configuration can
supersede system defaults. See [official Codex configuration
precedence](https://learn.chatgpt.com/docs/config-file/config-basic). The
original launcher's embedded-mode note for `-c`, `--enable`, `--disable`, and
`--search` is retained; the exact UI behavior depends on the installed Codex
version. Use persistent config for routine preferences.

Host shell variables such as `OPENAI_API_KEY`, proxy variables, and SSH agent
sockets are not forwarded automatically. This launcher provides ChatGPT device
login through `cx --login`; custom providers that need environment variables
require an intentional launcher change. Git can use HTTPS or credentials
available in shared folders; your host `~/.ssh` is not mounted by default.

## Work through SSH

SSH mode requires Python 3.11 or newer and OpenSSH **on the host**, a local
interactive terminal, and a remote Bash shell. Rebuild the cx image after
upgrading to get the `cx-remote` client. No Python packages are required.

```bash
cx . --ssh delta --remote-dir /remote/path/to/project
```

`delta` is the same host alias you would give your host's `ssh` command. The
host SSH process uses your existing configuration, keys, agent, ProxyJump,
and known hosts. cx does not copy those credentials into the container or
change your SSH configuration. `--remote-dir` is optional and is a literal
remote path (use an absolute path rather than `~`). Wrapper options precede
any `--` argument separator. Supply each of `--ssh`, `--remote-dir`, and
`--ssh-mount` at most once; `--add-dir` and `--add-file` are repeatable.

First, complete the SSH login directly in the terminal, including password,
key passphrase, MFA, or host-key confirmation. Once you see a Bash prompt,
press **Ctrl-]**, release it, then **c** to start Codex. If your login shell is
not Bash, enter `bash` first. Configurations with RemoteCommand must reach a
Bash shell before handoff.

Switching between established terminals changes input routing without typing
shell commands into the remote session. The first Ctrl-] c performs shell
setup, so use it only after reaching the Bash prompt. The bridge isolates common keyboard/focus/paste modes
and answers display queries from the requesting session's virtual terminal.
Physical terminal reports left over from previous activity are discarded
instead of becoming password or prompt text. On normal completion, commands restore the
remote terminal settings they started with; internal framing is hidden from
normal output. Bracketed paste is passed through without interpreting its
contents as bridge shortcuts.

While Codex runs:

- **Ctrl-] r** switches to the remote terminal for authentication or interaction.
- **Ctrl-] c** returns to Codex once that interaction is complete.
- **Ctrl-] b** returns from the renderer's saved history to the live screen.
- **Ctrl-] m** toggles wheel capture; when off, plain dragging selects text.
- **Ctrl-] q** exits the SSH-mode cx session (status 130), including during login.
- **Ctrl-] Ctrl-]** sends a literal Ctrl-] to the selected terminal.
- To interrupt a remote command, switch to SSH and press Ctrl-C. Return only
  after reaching a shell prompt. The command is reported as interrupted;
  its effects may be incomplete.

### Separate screens and session bar

SSH-mode sessions use independent saved terminal screens. The full-width top
row is **green and labeled SSH** or **blue and labeled CODEX**. It stays visible
when an application clears its screen, uses an alternate buffer, or scrolls.
Brief connection notices appear in this bar instead of over application text.

Ctrl-] r/c restores the selected session's current screen, cursor, and styles.
Output produced while a session is hidden updates only its saved screen; cx
does not replay old raw output over the active application. Background Codex
updates are visible when you return to it. The bar reserves one row, and cx
resizes both application PTYs to the remaining height.

Wheel scrolling is enabled by default. When an application requests mouse
input, wheel events go to that application with coordinates adjusted for the
bar. Otherwise, the wheel browses the renderer's saved history, three lines
per event. Each session's normal and alternate screens keep up to 2,000
scrolled-off lines independently. This is terminal output history, not a
separate copy of the full Codex conversation.

While browsing saved history, the bar shows **HISTORY** and the cursor is
hidden. New output continues updating the live screen without snapping your
view back. Scroll down, press **Ctrl-] b**, or type to return to the live view.
Switching between SSH and Codex preserves each screen's history position.

Hold **Shift while dragging** to select text, then use your terminal's copy
shortcut (**Ctrl+Shift+C** in Windows Terminal). Press **Ctrl-] m** to disable
wheel capture for plain drag selection; press it again to restore scrolling.
Clicks and drags are not forwarded to applications; use keyboard navigation
for those controls. Local sessions without `--ssh` retain their usual behavior.
See [Windows Terminal selection](https://learn.microsoft.com/en-us/windows/terminal/selection).

The renderer ships with cx as pure Python source. There is no tmux dependency
and no host pip installation. It preserves VT dim/bold/italic text, underline
styles and colors, reverse/hidden/struck/overlined text, foreground and
background shading, ANSI/indexed palette references, and RGB colors across
switches and history views. Your terminal still chooses the font face and
determines which style extensions it can display. `COLORTERM` is forwarded
from the host so applications retain its color capability information.
The bridge probes the terminal's default foreground/background/cursor colors
once and caches valid replies for application theme queries; terminals that
do not answer use the existing light-text/dark-background defaults. These
replies are consumed locally, never entered into a password or prompt.
The renderer also handles cursor operations and normal/alternate screens;
terminal graphics extensions are not forwarded.
Display queries use virtual coordinates that exclude the bar. Advanced
keyboard support is not advertised by the virtual terminal; standard input
and the existing input-mode safeguards remain available.

Closing cx restores the enclosing terminal's screen. Local sessions without
`--ssh` retain their normal Codex display and have no added session bar.

### SSH MCP tools

`--ssh HOST` automatically registers the session-only `cx_ssh` stdio server
after you complete SSH login and hand control to Codex. It uses the existing
private bridge socket; SSH keys and authentication stay on the host. It adds
no network listener and does not change saved MCP settings or permissions.

```bash
cx /path/to/project --ssh delta --remote-dir /srv/project
# CLI-only fallback:
cx /path/to/project --ssh delta --no-ssh-mcp
```

| Tool | Arguments and result |
|---|---|
| `ssh_status` | No arguments; readiness, focus, mount, bridge session ID, active command ID. |
| `ssh_exec` | `command`: start once and return a command ID. Directory/environment changes persist. |
| `ssh_poll` | `command_id`, optional byte `cursor`: state, combined output, next cursor, truncation, exit code when known. |
| `ssh_cancel` | `command_id`: request Ctrl-C once; interruption is not rollback. |

Only one command runs at a time across MCP and CLI. Busy/manual SSH focus
rejects new commands without queueing. Polling never reruns commands. Tool
errors/timeouts must not trigger a fallback execution through `cx-remote`.
A transport error from `ssh_exec` includes its generated ID; poll that ID or
inspect status instead of resubmitting the command.

Tracking lives in the host bridge for this cx session, surviving MCP restarts
and tool-call timeouts. It does not survive exiting cx. States are `running`,
`interrupt_requested`, `completed`, and `unknown`. A confirmed completion
includes the actual exit code. SSH disconnect leaves unfinished work unknown;
reconnecting never replays it. Tool-call cancellation alone does not interrupt
remote work; use `ssh_cancel` explicitly. If Ctrl-C does not produce completion
framing, the shell stays busy; use Ctrl-] r and manual recovery/reconnection.

Each command keeps the latest 1 MiB of output; retain up to 32 finished records.
Poll retrieves up to 64 KiB per call using `next_cursor`. Truncation and expired
IDs are explicit. Text output is a UTF-8 preview; `output_base64` preserves exact
PTY bytes, including split Unicode. stdout/stderr are combined. Output during
manual SSH interaction is excluded from agent results, as with CLI execution.

The `cx_ssh` registration name is reserved. Rename a conflicting user/project
server or pass `--no-ssh-mcp`. File browsing and editing still use ordinary
file tools through SSHFS or existing remote commands; no dedicated MCP file
or environment-management tools are added.

### Interactive CPU and GPU sessions

Run setup on the Linux/WSL host for each SSH alias. Choose an **absolute path
on storage shared by that server's login and compute nodes**. It can contain
spaces and is interpreted on the server, not inside the cx container:

```bash
cx --setup-slurm my-cluster --shared-dir /shared/myuser/cx
cx --setup-slurm another-cluster --shared-dir '/shared/myuser/cx data'
cx --setup-slurm third-cluster --shared-dir /shared/myuser/cx \
  --job-id-pattern 'Allocation #([0-9]+)'
```

Setup uses your host OpenSSH configuration and interactive authentication; it
does not require Docker or request a Slurm allocation. It creates a private
`interactive` directory beneath the selected root and installs
`~/.bashrc.d/cx-interactive.sh`. If needed it appends a managed source line to
`~/.bashrc`, first backing up the existing file. It refuses to overwrite an
unrecognized hook. Repeating setup is idempotent; running it again with a new
path updates that alias while retaining remote roots for other sessions.

Host-side mappings are saved in `~/.config/cx/slurm-servers.json` (under
`$XDG_CONFIG_HOME/cx` when set), or in the file named by `CX_SLURM_CONFIG`.
Later `cx --ssh alpine` sessions select that alias's configured directory
automatically. `ssh_status` reports it as `interactive_directory`, a remote
path; it is not automatically mounted into the container. The remote hook
reads configured roots from `~/.config/cx/slurm-roots` and emits a marker
containing the Slurm job ID and random token when an interactive allocation shell
reaches a prompt. It is inactive outside Slurm. Interactive allocation tools
require a configured alias; without one they return `not_configured` before
sending a command. Normal SSH and `cx-remote` work without Slurm setup.
The selected directory contains interactive rendezvous files; command output
and status records remain in the host bridge's memory for the current session.
The hook and the small roots locator stay under the remote home directory so
Bash can find the selected shared paths during startup. Slurm output-log paths
remain controlled by your `cpu` and `gpu` functions and site configuration.

Setup checks login-node paths and hook installation; it cannot prove that the
chosen directory or Bash startup configuration is shared with compute nodes.
The bridge recognizes `Interactive job with ID N`, `Granted job allocation N`,
`Submitted batch job N`, and `salloc: job N` or `srun: job N` in scheduler
output. For another message, supply `--job-id-pattern` with
exactly one capture group for the numeric job ID, as in the example. The
pattern augments the built-in patterns and is saved for that alias. Repeating
setup without the flag keeps the existing pattern; pass `--job-id-pattern ''`
to remove it. The existing `cpu` and `gpu` Bash functions must be loaded in
the login shell and launch an interactive Bash shell with `SLURM_JOB_ID` set.
The observed job ID becomes fixed once the allocation shell is confirmed; later
command output cannot redirect the session to another job ID.

Readiness confirms the Slurm job ID, not that the shell is physically on a
compute node. Some `salloc` workflows leave the shell on a login node; check
`hostname` and use your site's `srun` or other approved method as needed.

For an explicitly requested allocation, call `ssh_interactive_start` with a
`cpu ...` or `gpu ...` command, then `ssh_poll` its returned ID until
`interactive_ready` is true. cx requires the matching Slurm job ID and token;
queue messages or a login/authentication prompt do not count as readiness.
Call `ssh_interactive_exec` with the session ID and command, then poll its new
command ID for combined output and exit status. Directory and environment
changes persist in the compute shell. Commands must fit in a terminal line.
Call `ssh_interactive_close` on the session ID to exit the shell and return to
the login shell. Only one nested command can run at once. `ssh_cancel` requests
Ctrl-C for a queued allocation or active nested command; once an allocation is
ready, use close to exit it. If the prompt returns without a completion marker,
the outcome is unknown. Never replay work after a timeout or disconnect.

If authentication is needed, use Ctrl-] r and complete it manually. Input is
blocked while you control SSH. cx requires another matching hook marker after
manual input before it permits another command. The remote mount remains rooted
on the login host; it does not follow the compute allocation. GNU screen and
live Slurm behavior depend on the site; test with a small authorized allocation.

### Remote commands

The container helper provides remote execution:

```bash
cx-remote status
cx-remote exec 'pwd; hostname'
cx-remote exec 'module load python; export PROJECT_MODE=analysis'
cx-remote exec 'printf "%s\n" "$PROJECT_MODE"'
```

Commands run serially in the same shell: `cd`, loaded modules, variables, and
activated environments persist. Output combines stdout and stderr through a
terminal and may contain terminal control sequences. Requesting another command
while the shell is busy or in user control returns an error. Direct terminal
interaction is not included in command output returned to Codex; output produced
while you control the remote terminal is shown there instead.

Without `--ssh-mount`, local file tools access the local project and any added
local files/directories; use
`cx-remote` to read or edit remote files. Optional filesystem access at
`/workspace/remote` is described below.

SSH mode combines the installed system developer instructions with remote
instructions through a session CLI override, including for preserved older
configs. As with other CLI overrides, Codex UI behavior depends on its version.

If SSH disconnects, cx reports an unknown command outcome and never retries
that command automatically. Press Ctrl-] r to reconnect, log in again, then
Ctrl-] c to resume. A new shell loses previous state and reapplies the initial
`--remote-dir`. Confirm earlier command effects before repeating work.

For Alpine or Delta, request Slurm resources only when explicitly authorized.
Use the interactive MCP tools for the supported cpu/gpu shell workflow, or
switch to the remote terminal for manual interaction. A command that exits or replaces the
shell, or changes its input/prompt behavior, can prevent completion detection;
use terminal handoff to recover. Closing cx terminates its local SSH process;
remote job cleanup follows the remote system's normal policies.

Headless SSH mode and attaching unrelated existing SSH terminals are not
supported. Real Delta MFA and live Docker integration require validation on
your host; offline tests use a fake SSH endpoint and real pseudo-terminals.

### Browse remote files inside the container

Keep the SSH shell and remote execution, and optionally mount the selected
remote directory at `/workspace/remote`:

```bash
cx /local/project --ssh delta --remote-dir /remote/project --ssh-mount
cx /local/project --ssh delta --remote-dir /remote/project --ssh-mount=rw
```

`--ssh-mount` and `--ssh-mount=ro` provide read-only file browsing.
`--ssh-mount=rw` allows edits that immediately affect the server. These options
require `--ssh` and an explicit absolute `--remote-dir`. Without them, cx
keeps its existing local-only or SSH-command-only behavior.

The host needs `sshfs`, working FUSE, and `fusermount3` (or `fusermount`).
The server must support SFTP. The mount uses `allow_other,default_permissions`
so Docker can access it; non-root hosts normally need `user_allow_other`
enabled in `/etc/fuse.conf`. cx does not install packages or change that
file. The temporary parent directory is private to your user. See the
[SSHFS manual](https://github.com/libfuse/sshfs/blob/master/sshfs.rst) for
FUSE permissions and setup. Rootless or UID-remapped Docker may require
additional host permission configuration.

Complete the normal SSH login/MFA and press Ctrl-] c. cx starts SSHFS over
the authenticated SSH control connection, then starts Codex with `/workspace/remote`
added to its available directories. Mount failure stops session startup with
a diagnostic; it does not silently switch to an empty local directory.

Codex receives the host alias, initial remote directory, container mount path,
and read/write mode in its session instructions. `cx-remote status` reports
the initial directory, mount path/mode, and whether the SSHFS process is alive.
That process status is not a guarantee of server reachability. Ordinary file
tools can browse `/workspace/remote`; local project files remain at `/workspace/main`.
Remote programs still run through `cx-remote exec` using server paths:

```bash
# Container-side file access, read-only unless --ssh-mount=rw:
ls /workspace/remote
cat /workspace/remote/README.md
# Execution on the remote machine:
cx-remote exec 'pwd; hostname; ./run-tests'
```

The mount always points to the initial directory on the configured SSH host.
It does not follow `cd` in the persistent shell or move to a Slurm compute
node. SFTP and the interactive shell must see the same server path. This is
a live filesystem view, not a synchronized copy; network latency, SSHFS
semantics, and remote permission checks apply. `.codexignore` overlays for
local workspaces do not mask files in this optional remote mount.

If the SSH transport or filesystem connection fails, file operations may
error or wait for the SSH keepalive timeout. Restart cx to recreate the mount;
reconnecting only the command shell does not repair the existing Docker bind
mount. The read-only option affects the filesystem view, not the SSH account's
ability to modify files through commands. cx unmounts its owned SSHFS mount
on normal exit and attempts a lazy detach if it is busy. If unmounting fails,
it reports and retains the temporary directory for manual recovery.

Live SSHFS/FUSE and Docker mount behavior must be validated on a host with
those facilities; offline tests mock mount lifecycle operations.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `cx: command not found` | Add the installation prefix's `bin` to PATH; for portable use, invoke its `cx` path. |
| Docker is missing or inaccessible | Run `docker info` as your user, start Docker, check local context or WSL integration. |
| Image does not exist | Run `cx --build` or portable `./cx --build`. |
| Device login fails | Check account or workspace device-login settings and [the authentication guide](https://learn.chatgpt.com/docs/auth). |
| Keyring unavailable inside container | Configure `cli_auth_credentials_store = "file"` in the active Codex user config, if your organization permits it, then sign in again. |
| Permission denied in a project or environment store | Verify ownership for the invoking UID/GID. Rootless/remapped Docker may need host ownership adjustments. |
| Workspace overlaps credentials | Select only the project directory; keep the portable bundle and its `data/` outside it. |
| Environment selection seems unchanged | Use `cx-env run -- COMMAND` now or restart the session; check for a `CX_ENV_NAME` override. |
| Packages vanished after moving a project | Stores are keyed by absolute project path; recreate from an environment export. |
| Program tries writing under `/usr` or `/tmp` execution fails | Install tools into a named environment in `/cx-env`; the root is read-only and Codex `/tmp` is `noexec`. |
| Connection to a private service fails | Host network/proxy variables are not automatically forwarded; the container has its own network context. |
| A new build still has an old Codex version | Use `cx --rebuild` to bypass cached npm layers. |
| File save fails with a busy mountpoint | For `--add-file`, write in place or share its parent using `--add-dir`. |
| Password input contains unexpected text or Codex receives stray terminal sequences after handoff | Install the updated wrapper and exit all old SSH sessions. Restart cx; if the host display remains garbled, run `reset` outside cx first. |
| SSH login needs MFA or interaction | Press Ctrl-] r, complete it directly at the terminal, then Ctrl-] c. |
| Dragging does not select text in an SSH-mode session | Hold Shift while dragging, then copy with Ctrl+Shift+C in Windows Terminal. Ctrl-] m disables wheel capture for plain drag selection. |
| Wheel does not scroll chat history in SSH mode | Press Ctrl-] m to enable wheel capture. Mouse-aware applications handle their own scrolling; otherwise the renderer browses its saved terminal history. |
| SSHFS mount fails at startup | Check host SSHFS/FUSE, server SFTP, and `user_allow_other` in `/etc/fuse.conf`. |
| Remote mount fails after a disconnect | Restart cx to recreate the filesystem view; shell reconnection alone is insufficient. |
| `/workspace/main` or the remote client is missing | Rebuild the image after upgrading and restart the session. |
| A mount path contains a comma | Move it to a path without commas. Spaces are supported. |

`cx --doctor` prints paths and prerequisite status without creating data or
changing settings. It returns nonzero if a required item is missing. It does
not inspect credentials or send them anywhere.

### Updating to the 1.2.1 SSH MCP bridge

Run `./install.sh` from the release on the host, including its default image
build, then restart sessions. A host-only `--no-build` update needs `cx --build`
before automatic MCP works. Use `--no-ssh-mcp` temporarily with older images.
See [installation and upgrades](INSTALL.md#upgrading-to-121).
