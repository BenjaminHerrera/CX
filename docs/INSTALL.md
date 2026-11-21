# Installation and distribution

[Handbook home](README.md) · [First installation walkthrough](GETTING-STARTED.md) · [Upgrade and backup walkthrough](UPGRADING.md)

The multi-CLI/session-menu integration is merged into `main`. Use a checkout
of `main` for the current source installation. The examples below also cover
packaged editions when archives are available; they do not imply that a GitHub
release has been published. The current source version is `2.1.3`.

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

Managed interactive local sessions require host Python 3.11+ for the saved-screen
session menu, but no SSH setup. Noninteractive tasks and history maintenance do
not require host Python. For `--ssh`, also install OpenSSH and use an interactive
terminal. The
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
tar -xzf cx-2.1.3-install.tar.gz
cd cx-2.1.3-install
```

For portable use, extract `cx-2.1.3-portable.tar.gz` instead. The checksum command
expects both archives to be present; if you downloaded only one, compare its
`sha256sum` output with its matching line in `SHA256SUMS`. Checksums detect
accidental changes; they do not authenticate an untrusted publisher.

## 3. Install and sign in

```bash
./install.sh
export PATH="$HOME/.local/bin:$PATH"
cx --doctor
cx accounts add --agent codex --account personal --auth subscription
cx --agent codex --account personal --login
cx /path/to/project
```

The export above affects this terminal. Add it to your shell profile for future
terminals. The first build downloads the Node base image, Linux tools,
Micromamba, and both CLI npm packages. It can take several minutes. A failed
build stops installation before changing the installed program.

Use `./install.sh --prefix /some/writable/location` for a different installation
prefix. Add that prefix's `bin` directory to PATH. Prefix selection changes
**program and system configuration** locations; the default credential and
environment paths stay under your home directory. Override `CX_DATA_HOME`
and `CX_ENV_HOME` if desired. Explicit `CX_CODEX_HOME` selects legacy Codex mode.

Use `./install.sh --no-build` to copy the program without accessing Docker or
networks. Then run `cx --build` when Docker is available. The installer never
installs dependencies on the host.

## Account Migration and Image Rebuild

Rebuild the image after this update. Fresh managed profiles do not import existing
native credentials or history automatically. To copy conversations separately,
use the [native session importer](ACCOUNTS.md#import-existing-native-sessions).
Create profiles and sign in explicitly as shown
above; see [accounts and history](ACCOUNTS.md) for storage paths and open live
validation gates. To retain an existing native Codex home, explicitly set
`CX_CODEX_HOME="$HOME/.codex"`; for an older portable bundle, use its `data/codex`
path. Legacy mode cannot be combined with managed selection or Claude.

The image defaults to Claude 2.1.323; set `CX_CLAUDE_VERSION` before building for
an override. `CX_CODEX_VERSION` remains supported. Both Claude self-update paths
are disabled; update through an image rebuild. Claude permission bypass requires
a non-root host UID. The current package version is 2.1.3.

## CX-13 MCP Adapter Rebuild (Target v2.1.2)

The startup-permission fix requires rebuilding the Docker image for **both
installed and portable editions**. A host-only update cannot repair a root-owned
0600 `/opt/cx-mcp/server.mjs` in an existing image. Install the updated source
with the default image build, or run `cx --rebuild` after `./install.sh --no-build`.
For portable use, update the program files while retaining private `data/`, then
run `./cx --rebuild`. Restart sessions after rebuilding.

The image makes MCP runtime code and dependencies readable and directories
traversable without allowing session-user writes. Credential and bridge-socket
permissions are unchanged. Startup preflight runs as the assistant UID/GID and
checks a bounded MCP initialize/tools-list handshake without credentials or
access to the remote bridge. It reports permission/load/handshake errors before
the assistant launches, with bounded server stderr. Successful preflight does
not establish an SSH connection or authenticate a provider.

Use `--ssh HOST --no-ssh-mcp` as a temporary opt-out if an image cannot yet be
rebuilt; `cx-remote` remains available. Never replay an earlier command whose
outcome is unknown. See [image validation](MAINTAINING.md#cx-13-validation-target-v212)
for the restrictive-source Docker regression command and unverified live gates.

## Portable edition

```bash
tar -xzf cx-2.1.3-portable.tar.gz
cd cx-2.1.3-portable
./cx --build
./cx accounts add --agent codex --account personal --auth subscription
./cx --agent codex --account personal --login
./cx /path/to/project
```

The launcher uses `data/profiles`, `data/history` and `data/environments` beside itself. They are
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
<a id="upgrading-to-114"></a>
<a id="upgrading-to-120"></a>

<a id="upgrading-to-121"></a>

<a id="upgrading-to-201"></a>

<a id="upgrading-to-210"></a>

<a id="upgrading-to-211"></a>

<a id="upgrading-to-212"></a>

### Upgrading to 2.1.3

From the updated repository or extracted `cx-2.1.3-install` directory,
on your Linux/WSL host outside cx:

```bash
./install.sh
cx --version
# Expected: cx 2.1.3
```

Reuse your original `--prefix` if customized. The default build installs the
MCP adapter and its locked dependencies into the image. Exit old sessions
and start new ones. Unlike 1.1.x host-only patches, automatic MCP requires a
new image when upgrading from older adapters. The remote startup hook introduced
in 1.2.1 is still required for interactive CPU/GPU sessions; see
[interactive setup](USAGE.md#interactive-cpu-and-gpu-sessions).
Run `cx --setup-slurm SSH_ALIAS --shared-dir /shared/path/cx` on the host to
install it and save a separate location per SSH alias. Interactive allocations
now require explicit setup instead of a site-specific fallback. To migrate
an existing managed installation, rerun setup with the desired existing or new
shared cx root; the installer recognizes and upgrades previous managed hooks.
Restart active sessions after upgrading. Setup does not need Docker.
If you use `./install.sh --no-build`, run `cx --build` afterward,
or temporarily use `--ssh HOST --no-ssh-mcp`. Missing adapters fail explicitly.

User MCP configuration is preserved. The session-only name `cx_ssh` is
reserved; rename a conflicting server or use `--no-ssh-mcp`. This feature does
not change Codex approval settings or grant additional permissions.

For portable upgrades, extract `cx-2.1.3-portable.tar.gz`, transfer private
`data/` while sessions are stopped, merge intentional configuration changes,
and run `./cx --build`. Never replace saved data with an empty directory.
Credentials, environment stores, and workspace paths are unchanged.

### Workspace migration from 1.0.x

The three-folder layout was introduced in 1.1.0 and is unchanged in 2.1.3.
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

The installed edition preserves `~/.local/share/cx/environments` and creates
fresh account homes under `~/.local/share/cx/data`. To reuse `~/.codex`, explicitly
set `CX_CODEX_HOME="$HOME/.codex"` (legacy mode). The old Dockerfile, environments, and
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
