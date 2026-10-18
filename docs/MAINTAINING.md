# Maintenance and verification

The host program is Bash. The regression suite uses only Node.js built-in
modules; it has no npm dependencies and installs no packages. Node.js is a
maintainer tool, not an end-user host requirement.

## Check a change

Run these commands from the source tree or an extracted release. Installed
program folders contain runtime files and documentation; maintenance scripts
and tests remain in the source distribution.

```bash
bash -n cx bin/cx install.sh uninstall.sh container/cx-entrypoint container/cx-env scripts/package.sh scripts/verify-docker.sh
node tests/smoke.mjs
```

The offline suite uses an isolated temporary HOME and a fake Docker executable
to check command arguments, mount paths, portable data defaults, piped sessions,
installation, upgrade preservation, refusal to overwrite unrelated programs,
uninstallation, environment selection, release contents, and extracted bundles.
It never signs in or builds an image. Temporary fixtures are removed afterward.

Passing offline tests does not verify Docker runtime mount behavior, a real
image build, platform-specific filesystem behavior, or service authentication.
On a supported host with a local Docker daemon, run:

```bash
./scripts/verify-docker.sh --build
```

This builds the configured image, extracts clean releases, installs to a
disposable prefix, and launches both editions against temporary projects.
It checks real project writes, added directories, empty read-only ignore
mounts, and persistent storage across containers. It uses temporary credential
stores, never signs in, and never sends a model request. Fixtures are removed
on exit. Omit `--build` to test an existing image. The command returns nonzero
on failure. Tests require a writable source directory and use paths with spaces.

**Current validation status:** the offline suite passed in the supplied
container. Docker is unavailable there, so this Docker verification script,
image build, and live authentication have not been validated end to end.

After Docker verification passes, sign in with a real edition and start a
session on a disposable project to verify account access. Test amd64/arm64 on
the actual platforms you plan to support; a passing test applies to its host.

## Build shareable archives

```bash
./scripts/package.sh
cd dist
sha256sum -c SHA256SUMS
```

The script creates two gzip-compressed tar archives with versioned top-level
folders. Each includes `START-HERE.txt`, the full documentation, and
`MANIFEST.sha256` for its files. The install edition points users to
`./install.sh`; the portable edition points to `./cx`. Both share the same
runtime code and can use either entry point. This avoids two diverging copies
of the launcher.

To verify files after extraction, run `sha256sum -c MANIFEST.sha256` in the
extracted folder. The outer `SHA256SUMS` file checks the compressed archives.
Use `./scripts/package.sh --output /some/directory` to choose a destination.
Release archives are source bundles; the image is not bundled.

Only paths listed in `scripts/package.sh` are packaged. Do not replace that
list with `tar .`: a working portable directory can contain access tokens,
project environments, and caches. Review the list when adding new files.
Update `VERSION` and `CHANGELOG.md` before issuing a new release. Generated
archives are intentionally ignored by Git.

## Source lineage and dependencies

Input files were read from:

- `.local/bin/cx`
- `.local/bin/cx-config/config.toml`
- `.local/share/cx/Dockerfile`
- `.local/share/cx/cx-entrypoint`
- `.local/share/cx/cx-env`

Personal settings, credentials, workspace-path metadata, and existing
Micromamba environments were not imported. The provided files had no license
notice; this package does not assign a license on the source owner's behalf.
Before publishing publicly, the owner should choose the distribution license.
Container components retain their own upstream licenses.
