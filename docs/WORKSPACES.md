# Workspaces and Environments

[Handbook home](README.md) · [Command reference](USAGE.md)

## Know Which Directory You Are Using

The project argument is a directory on your **host**:

```bash
cx "$HOME/projects/app"
```

Inside the container, sessions start here:

```text
/workspace/
├── main/          your selected local project
├── cx-external/   extra local directories and files
└── remote/        optional SSHFS view of a server directory
```

| You refer to… | Use this location |
|---|---|
| A project file inside CX | `/workspace/main/README.md` |
| An added local directory | `/workspace/cx-external/shared/` |
| A mounted server directory | `/workspace/remote/` |
| The authenticated SSH shell | Its own remote cwd; inspect with remote `pwd` |

These names are container mounts. CX does not move your host project into a
new `main` folder. Writable mount edits affect the originals. The remote view
is empty unless you request `--ssh-mount`.

## Add Local Directories or Files

Run on the host:

```bash
cx "$HOME/projects/app" --add-dir ../shared --add-dir /data/datasets
cx "$HOME/projects/app" --add-file "$HOME/notes.md"
```

Relative added paths are resolved from the selected project, not your host
terminal's cwd. Extra names come from their basenames; collisions get numeric
suffixes. Files already inside the project keep their project path. Directories
and individual files are writable. Use **in-place writes** for individually
mounted files: saving by rename/replacement of the mountpoint is unsupported.
Share the parent directory when your editor requires atomic replacement.

Use `--add-dir` for extra local directories. `--remote-dir` selects an SSH
directory and belongs to SSH mode. Paths containing spaces work when quoted;
paths used in Docker mounts cannot contain commas.

Do not share your whole home directory, native credential homes, CX private
data, or a project containing the portable bundle. CX rejects overlaps with
managed credentials and history.

## Hide Selected Project Paths

Add literal project-relative paths to `.codexignore`, one per line:

```text
.env
private-data
```

CX overlays empty read-only mounts on those paths. Names remain visible; this
is not a glob-based file picker or a separate security boundary. It does not
filter an SSHFS mount. See [workspace filtering](USAGE.md#hide-specific-project-paths).

## Keep Development Tools Between Runs

From the host, open a container shell for the project:

```bash
cd "$HOME/projects/app"
cx --shell
```

Then run **inside the container**:

```bash
cx-env active
cx-env list
micromamba create -y -n tools -c conda-forge python=3.12
cx-env use tools
cx-env run -- python --version
```

This creates a persistent named environment for this workspace. Avoid
Micromamba's base prefix. `cx-env use` sets future selection; it cannot change
the parent shell's PATH. Use `cx-env run -- COMMAND` now, or restart CX to get
the selected environment on PATH. A selected name can exist before its
environment is created; check `CX_ENV_AVAILABLE`.

To override the selection for one run, use the host:

```bash
CX_ENV_NAME=tools cx "$HOME/projects/app"
```

## What Persists?

| Content | Persistence |
|---|---|
| Writable project/extra mounts | Original host files |
| Read/write remote mount | Original server files |
| Account credentials/settings | Selected private profile in `CX_DATA_HOME` |
| Conversations and CX names | Shared history for the selected CLI |
| Named environments | Workspace store under `CX_ENV_HOME` |
| Container `/tmp` and unmounted filesystem paths | Discarded with the container |

Installed data defaults to `~/.local/share/cx/data`; environments default to
`~/.local/share/cx/environments`. Portable mode uses `bundle/data` and
`bundle/data/environments`. Workspace environment associations use the host
project's canonical absolute path. Moving that project selects a different
environment store; moving only the portable bundle does not.
