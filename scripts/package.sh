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
    bin/cx bin/cx-ssh-bridge.py bin/cx-slurm-setup.py bin/cx_screen.py config/config.toml
    container/Dockerfile container/cx-entrypoint container/cx-env container/cx-remote container/.dockerignore
    container/mcp/package.json container/mcp/package-lock.json container/mcp/server.mjs
    tests/mcp.mjs tests/slurm_setup.py
    docs/INSTALL.md docs/USAGE.md docs/ARCHITECTURE.md docs/MAINTAINING.md
    scripts/package.sh scripts/verify-docker.sh scripts/cx-interactive-hook.sh tests/smoke.mjs tests/ssh_bridge.py tests/screens.py tests/remote-client.mjs
    # Bundled pure Python sources and notices; no installed binaries or caches.
    bin/vendor/README.md
    bin/vendor/pyte/AUTHORS
    bin/vendor/pyte/COPYING
    bin/vendor/pyte/LICENSE
    bin/vendor/pyte/__init__.py
    bin/vendor/pyte/__main__.py
    bin/vendor/pyte/charsets.py
    bin/vendor/pyte/control.py
    bin/vendor/pyte/escape.py
    bin/vendor/pyte/graphics.py
    bin/vendor/pyte/modes.py
    bin/vendor/pyte/screens.py
    bin/vendor/pyte/streams.py
    bin/vendor/wcwidth/LICENSE
    bin/vendor/wcwidth/__init__.py
    bin/vendor/wcwidth/_clip.py
    bin/vendor/wcwidth/_constants.py
    bin/vendor/wcwidth/_wcswidth.py
    bin/vendor/wcwidth/_wcwidth.py
    bin/vendor/wcwidth/_width.py
    bin/vendor/wcwidth/align.py
    bin/vendor/wcwidth/bisearch.py
    bin/vendor/wcwidth/control_codes.py
    bin/vendor/wcwidth/escape_sequences.py
    bin/vendor/wcwidth/grapheme.py
    bin/vendor/wcwidth/hyperlink.py
    bin/vendor/wcwidth/sgr_state.py
    bin/vendor/wcwidth/table_ambiguous.py
    bin/vendor/wcwidth/table_grapheme.py
    bin/vendor/wcwidth/table_grapheme_overrides/__init__.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_058c7585.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_2148ff29.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_244dc88b.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_336a71a1.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_33ac73f2.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_3a1895d5.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_59180a0d.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_65c6beb5.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_78f828e8.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_8c2ae14d.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_900356bf.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_97904ece.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_a5880eeb.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_b6d33cf4.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_c57c295b.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_cf02297d.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_e18ac6a7.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_e2b75ee3.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_fb5fd79b.py
    bin/vendor/wcwidth/table_grapheme_overrides/_known_fdc99132.py
    bin/vendor/wcwidth/table_grapheme_overrides/_registry.py
    bin/vendor/wcwidth/table_mc.py
    bin/vendor/wcwidth/table_overrides.py
    bin/vendor/wcwidth/table_term_programs.py
    bin/vendor/wcwidth/table_vs15.py
    bin/vendor/wcwidth/table_vs16.py
    bin/vendor/wcwidth/table_wide.py
    bin/vendor/wcwidth/table_zero.py
    bin/vendor/wcwidth/text_sizing.py
    bin/vendor/wcwidth/textwrap.py
    bin/vendor/wcwidth/unicode_versions.py
    bin/vendor/wcwidth/wcwidth.py
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
