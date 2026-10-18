# cx — Codex in a Docker container

`cx` runs the Codex CLI against a project directory inside a disposable Docker
container. Project edits are saved directly to your files. Credentials, Codex
settings, and optional development environments survive container restarts.

This package is based on the supplied `.local/bin/cx` and `.local/share/cx`
files. It includes everything needed to build the image and run the launcher;
you do not need Node.js or Micromamba installed on your host.

## Requirements

- A **Linux host**, or a Linux distribution inside **WSL2**. Native macOS and
  Windows shells are outside this package's supported scope.
- Bash 4 or newer, GNU coreutils (`realpath`, `sha256sum`, `install`), `sed`,
  and `tar`/`gzip` to extract releases. These are normally present on Linux.
- A running **local Docker daemon** that your user can access. For WSL2,
  enable Docker Desktop integration for your distribution. Remote Docker
  daemons cannot bind mount your local project files correctly.
- Internet access for the first image build, authentication, and Codex requests.
  A Codex account with access to the service is required.
- Enough host resources for the default session limits: 8 GB memory, 4 CPUs,
  and 1,024 processes. You can adjust these settings.

## Choose an edition

| | Installed | Portable |
|---|---|---|
| Start | `cx /path/to/project` | `/path/to/bundle/cx /path/to/project` |
| Program | `~/.local/share/cx/program` | Extracted folder |
| Credentials and settings | `~/.codex` | `bundle/data/codex` |
| Development environments | `~/.local/share/cx/environments` | `bundle/data/environments` |
| Best for | Everyday use on one machine | Keeping program and data together |

Both editions require Docker. The portable archive contains source files, not
a prebuilt image or a standalone executable. The image is built on each host,
unless you transfer it as described in the installation guide.

## Install

From this directory, or the extracted **install** archive:

```bash
./install.sh
```

This installs the program into `~/.local` and builds the Docker image. It does
not install Docker or edit your shell configuration. If prompted by the
installer, add this line to `~/.bashrc` (or your shell's profile) and open a new
terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then sign in and start a project:

```bash
cx --login
cx /path/to/your/project
```

Use the browser link and code printed during login. Device authentication may
need to be enabled in your account or organization. See the official
[Codex authentication guide](https://learn.chatgpt.com/docs/auth).

## Run portable

From this directory, or the extracted **portable** archive:

```bash
./cx --build
./cx --login
./cx /path/to/your/project
```

Keep the whole folder together. Run against a project **outside the bundle**:
the bundle contains the credential folder, and cx rejects workspaces that
contain it. You can run the launcher by its absolute path from any directory.
Portable mode does not modify PATH or install files into `~/.local`.

## Everyday commands

```bash
cx --doctor                              # Diagnose prerequisites and paths
cx .                                     # Work on the current project
cx . exec "Run the tests and fix failures" # Run a task without the interactive UI
cx . --add-dir ../shared                  # Share another writable directory
cx --shell                               # Open a container shell for this directory
cx --auth-status                         # Check sign-in
cx --build                               # Build, reusing cached layers
cx --rebuild                             # Download base updates and rebuild all layers
cx --logout                              # Sign out of the active credential store
```

For portable use, replace `cx` above with `/path/to/bundle/cx`.

## Where to go next

- [Installation, upgrades, migration, and removal](docs/INSTALL.md)
- [Usage, configuration, environments, and troubleshooting](docs/USAGE.md)
- [How the system works and what the container can access](docs/ARCHITECTURE.md)
- [Development, tests, and release packaging](docs/MAINTAINING.md)
- [Changes from the supplied files](CHANGELOG.md)

Ready-to-share archives are in `dist/`, with SHA-256 checksums. Release packaging
uses an explicit file list and excludes credentials and environment data. A
used portable folder's `data/` directory is private; do not share it.

## Verification status

The offline regression suite passes. A real image build, Docker runtime, and
live login have not been tested in the supplied container because Docker is
unavailable. On your Docker host, run `./scripts/verify-docker.sh --build`
from this source tree or an extracted release to test both editions before
relying on them. See [maintenance and verification](docs/MAINTAINING.md).
