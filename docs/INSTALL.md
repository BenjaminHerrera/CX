# Installation and distribution

## 1. Prepare Docker

Install Docker for your Linux distribution using its official installation
instructions, or use Docker Desktop with WSL2 integration. Start Docker and
confirm that both commands work as your normal user:

```bash
docker version
docker info
```

cx does not install Docker, change group membership, or require `sudo` for its
own installation. Avoid running cx as root: containers use the invoking user's
numeric UID/GID so project files retain that ownership. Use a local Docker
context with access to the project path. User namespace remapping and rootless
Docker may require additional bind mount ownership configuration.

The image supports Linux amd64 and arm64. Native macOS and PowerShell are not
supported by these GNU/Linux host scripts. Inside WSL2, keep projects in the
Linux filesystem for normal Linux permissions.

## Optional SSH prerequisites

Local sessions do not require Python or host SSH setup. For `--ssh`, install
Python 3.11+ and OpenSSH on the host and use an interactive terminal. The
remote session must reach a Bash shell. Host SSH aliases, keys, agents, jump
hosts, and authentication policies are used directly; no third-party Python
packages are needed: the terminal renderer and its pure Python libraries
ship with cx. tmux is not required. cx does not install host dependencies
automatically.

For `--ssh-mount`, the host additionally needs SSHFS, working FUSE, and
`fusermount3` or `fusermount`. The server must support SFTP. The mount uses
`allow_other,default_permissions` for Docker access, so non-root users
normally need `user_allow_other` enabled in `/etc/fuse.conf`. Configure that
intentionally on your host; cx does not edit it. Rootless/remapped Docker
can need further UID and permission configuration.

See [SSH usage](USAGE.md#work-through-ssh) for terminal handoff, MFA,
read/write mount modes, and reconnection behavior.

## 2. Verify and extract a release

If you received both archives and the checksum file:

```bash
sha256sum -c SHA256SUMS
tar -xzf cx-1.1.4-install.tar.gz
cd cx-1.1.4-install
```

For portable use, extract `cx-1.1.4-portable.tar.gz` instead. The checksum command
expects both archives to be present; if you downloaded only one, compare its
`sha256sum` output with its matching line in `SHA256SUMS`. Checksums detect
accidental changes; they do not authenticate an untrusted publisher.

## 3. Install and sign in

```bash
./install.sh
export PATH="$HOME/.local/bin:$PATH"
cx --doctor
cx --login
cx /path/to/project
```

The export above affects this terminal. Add it to your shell profile for future
terminals. The first build downloads the Node base image, Linux tools,
Micromamba, and the Codex npm package. It can take several minutes. A failed
build stops installation before changing the installed program.

Use `./install.sh --prefix /some/writable/location` for a different installation
prefix. Add that prefix's `bin` directory to PATH. Prefix selection changes
**program and system configuration** locations; the default credential and
environment paths stay under your home directory. Override `CX_CODEX_HOME`
and `CX_ENV_HOME` if desired.

Use `./install.sh --no-build` to copy the program without accessing Docker or
networks. Then run `cx --build` when Docker is available. The installer never
installs dependencies on the host.

## Portable edition

```bash
tar -xzf cx-1.1.4-portable.tar.gz
cd cx-1.1.4-portable
./cx --build
./cx --login
./cx /path/to/project
```

The launcher uses `data/codex` and `data/environments` beside itself. They are
created on first use. The image lives in Docker's storage, outside the bundle.
You can relocate the bundle and continue using the same credentials and
workspace environments on a compatible host. Keep Unix permissions intact.
Do not put the bundle inside the project you expose to cx.

Workspace environments are keyed by the canonical absolute project path.
Moving a project to a different absolute path selects a different environment
store. Moving only the bundle keeps the association with that project. Use
Micromamba environment exports to recreate environments across machines or
architectures; copied environment binaries may contain absolute paths or be
architecture dependent.

## Updates

Download/extract a fresh install release and run its `./install.sh`. Managed
program files are replaced and the old program is saved under
`PREFIX/share/cx/backup-TIMESTAMP.SUFFIX/program`. The existing
`PREFIX/share/cx/config/config.toml` is kept. Compare it with the new release's
`config/config.toml` if you want new default instructions. Credentials and
workspace environments are not part of the program update.

<a id="upgrading-to-112"></a>
<a id="upgrading-to-113"></a>

### Upgrading to 1.1.4

From the updated repository or extracted `cx-1.1.4-install` directory, on
your Linux/WSL host outside cx:

```bash
# An existing 1.1.0 image can be reused:
./install.sh --no-build
cx --version
# Expected: cx 1.1.4
```

Pass your original `--prefix` if customized. This patch changes the host SSH
supervisor and bundled renderer; it does not require rebuilding a working
1.1.0 image. The same procedure applies when upgrading from 1.1.1–1.1.3.
Exit all old SSH-mode sessions completely and start new ones: running supervisors
keep their previously loaded code. If an old session left terminal modes
in an unusual state, run `reset` in the Linux/WSL host shell outside cx
before restarting. No SSH password or saved-credential change is required
by this update.

Version 1.1.4 restores wheel scrolling in SSH mode and preserves dim text,
prompt shading, text styles, and terminal palette colors. Wheel capture is
enabled by default, so hold Shift while dragging to select text, then copy
with Ctrl+Shift+C in Windows Terminal. Ctrl-] m toggles capture for plain
drag selection; Ctrl-] b returns from saved history to the live view. Local
sessions without `--ssh` retain their usual mouse behavior.

For a new installation, a missing image, or an upgrade from before 1.1.0,
run `./install.sh` with its default image build instead. If you choose
`--no-build` in those cases, run `cx --build` before starting cx. Review the
workspace migration below for older installations.

For portable upgrades, extract the fresh `1.1.4` bundle, transfer your private
`data/` while sessions are stopped, and merge intentional configuration
customizations. Reuse an existing 1.1.0 Docker image or build one if absent.
Do not overwrite an existing data directory with an empty one.

### Workspace migration from 1.0.x

The three-folder layout was introduced in 1.1.0 and is unchanged in 1.1.4.
When upgrading from 1.0.x or older, rebuild the image and update scripts:

| Previous container path | 1.1.x container path |
|---|---|
| `/workspace/FILE` | `/workspace/main/FILE` |
| `/cx-external/NAME` | `/workspace/cx-external/NAME` |
| `/remote/FILE` (development SSH builds) | `/workspace/remote/FILE` |

Sessions now start at `/workspace` so all three locations are visible.
Use `cd main` for the selected local project. Host project paths, command-line
source directory arguments, credentials, and environment stores do not move.

The installed `config/config.toml` remains preserved. Compare
`~/.local/share/cx/config/config.toml` (or your prefix's equivalent) with the
release's `config/config.toml` and merge desired layout/file instructions.
SSH sessions additionally inject current session guidance even when the
preserved base text is older. Portable users should retain their private
`data/` and merge intentional configuration changes into the new bundle.

### Rollback and portable updates

To undo a program update, first move the current `program` directory aside,
then move a backup's `program` back to `PREFIX/share/cx/program`. The launcher
symlink will point to it. Program backups do not include Docker images: tag
an image separately before rebuilding if you need an image rollback.

For portable updates, extract a fresh bundle and, with cx stopped, move your
old `data/` directory into it. Also copy any intentional `config/config.toml`
changes. Never overwrite a bundle's existing data with an empty directory.

`cx --build` refreshes the base image and builds using cached layers. Cached
npm layers may retain an older Codex version. `cx --rebuild` refreshes every
layer and installs the currently selected package version. For a specific
version and a separate image tag:

```bash
CX_IMAGE=local/cx:team CX_CODEX_VERSION=YOUR_VERSION cx --rebuild
CX_IMAGE=local/cx:team cx /path/to/project
```

Replace `YOUR_VERSION` with a published npm version. `latest` is the default;
these sources do not promise reproducible image bytes. For stricter builds,
pin the Node base digest, `CODEX_VERSION`, and apt sources in the Dockerfile.
Micromamba is already pinned to the supplied version and its downloaded binary
is checked against the release checksum.

## Migrate from the supplied .local layout

The installer refuses to overwrite an unrelated `PREFIX/bin/cx`, including the
original launcher. Preserve it by renaming it first:

```bash
mv "$HOME/.local/bin/cx" "$HOME/.local/bin/cx.original"
./install.sh
```

The new default installed edition reuses `~/.codex` and
`~/.local/share/cx/environments`. The old Dockerfile, environments, and
`~/.local/bin/cx-config` directory are left in place. To retain customized
system instructions, copy the old `cx-config/config.toml` into
`~/.local/share/cx/config/config.toml` after installation. Review that file
before copying; defaults are already provided. Save custom changes to the old
Dockerfile separately and apply them to the new `program/container/Dockerfile`.

## Transfer a Docker image without rebuilding

On a host where the image has been built:

```bash
docker save -o cx-image.tar local/codex-isolated:latest
```

Transfer the image archive and a clean portable bundle to a host with the same
CPU architecture, then run:

```bash
docker load -i cx-image.tar
/path/to/bundle/cx --doctor
/path/to/bundle/cx --login
```

This avoids a build download. Codex still needs service connectivity. The
provided release archives do not contain `cx-image.tar`.

## Remove an installation

From an install release:

```bash
./uninstall.sh
# For a custom prefix:
./uninstall.sh --prefix /some/writable/location
```

You can also invoke `~/.local/share/cx/program/uninstall.sh`. Removal deletes
the managed program and its launcher symlink. It preserves configuration,
credentials, environment stores, program backups, and Docker images. Remove
a PATH line from your profile yourself if it is no longer useful.

Portable removal consists of stopping its containers and deleting its bundle.
That also deletes its private `data/`; copy anything you want to keep first.
Deleting a bundle or uninstalling cx never deletes project directories.
