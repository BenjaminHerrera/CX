#!/usr/bin/env bash
# Build clean source distributions. Never include runtime data.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
output="$root/dist"
case "${1:-}" in
    --output) [[ $# == 2 ]] || exit 2; output="$2" ;;
    -h|--help) printf 'Usage: scripts/package.sh [--output DIRECTORY]\nCreates install and portable tar.gz archives plus SHA256SUMS.\n'; exit 0 ;;
    '') ;;
    *) printf 'package: unknown option\n' >&2; exit 2 ;;
esac
version="$(cat "$root/VERSION")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'package: invalid VERSION\n' >&2; exit 1; }
mkdir -p -- "$output"
output="$(cd -- "$output" && pwd -P)"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
# Explicit file list: adding a file to the repository does not distribute it.
files=(
    VERSION README.md CHANGELOG.md .gitignore cx install.sh uninstall.sh
    bin/cx bin/cx-ssh-bridge.py config/config.toml
    container/Dockerfile container/cx-entrypoint container/cx-env container/cx-remote container/.dockerignore
    docs/INSTALL.md docs/USAGE.md docs/ARCHITECTURE.md docs/MAINTAINING.md
    scripts/package.sh scripts/verify-docker.sh tests/smoke.mjs tests/ssh_bridge.py tests/remote-client.mjs
)
for edition in install portable; do
    name="cx-$version-$edition"
    bundle="$stage/$name"
    mkdir -p -- "$bundle"
    for file in "${files[@]}"; do
        mkdir -p -- "$bundle/$(dirname -- "$file")"
        cp -p -- "$root/$file" "$bundle/$file"
    done
    if [[ "$edition" == install ]]; then
        printf 'cx %s — install edition\nStart with: ./install.sh\nThen: cx --login\nRead README.md and docs/INSTALL.md first.\n' "$version" > "$bundle/START-HERE.txt"
    else
        printf 'cx %s — portable edition\nStart with: ./cx --build\nThen: ./cx --login\nRun: ./cx /path/to/project (outside this bundle)\nRead README.md and docs/INSTALL.md first.\n' "$version" > "$bundle/START-HERE.txt"
    fi
    (cd -- "$bundle"; sha256sum -- "${files[@]}" START-HERE.txt > MANIFEST.sha256)
    tar -czf "$output/$name.tar.gz" -C "$stage" "$name"
done
(cd -- "$output"; sha256sum "cx-$version-install.tar.gz" "cx-$version-portable.tar.gz" > SHA256SUMS)
printf 'Created install and portable packages in %s\n' "$output"
