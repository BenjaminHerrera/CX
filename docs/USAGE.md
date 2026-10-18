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

The optional first directory selects the primary workspace. Other arguments
are passed to Codex, except the launcher-specific commands in `cx --help` and
`--add-dir`, which cx processes. Use the explicit directory argument if a
Codex argument could also be the name of a directory in your current folder.
Host directories supplied as prompts or other Codex path arguments are not
translated automatically: use `/workspace` paths inside the session.

Docker gets a terminal only when stdin and stdout are terminals. Redirected
`exec` commands work without `-t`. The container's exit status is returned to
your shell. Container files outside the mounts and persistent environment store
are discarded when the process exits.

## Extra directories

```bash
cx /projects/app --add-dir ../shared --add-dir /datasets/current
cd /projects/app
cx --shell --add-dir ../shared
```

Relative paths resolve from the primary workspace. A subdirectory of that
workspace stays at `/workspace/subdirectory`. An external directory becomes
`/cx-external/BASENAME`; name collisions get `-2`, `-3`, etc. These mounts are
writable and changes affect the host immediately. `--add-dir` cannot expose
`/`, an ancestor of the workspace, or the credential directory and its
ancestors/children.

`cx --shell` uses the current directory as its workspace and only accepts
`--add-dir` options. It starts Bash after environment setup. `exit` leaves it.
The shell has the same project, credentials, and environment mounts; it does
not run Codex or load the Codex system instructions.

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
| A mount path contains a comma | Move it to a path without commas. Spaces are supported. |

`cx --doctor` prints paths and prerequisite status without creating data or
changing settings. It returns nonzero if a required item is missing. It does
not inspect credentials or send them anywhere.
