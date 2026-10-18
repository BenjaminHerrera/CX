#!/usr/bin/env bash
# User installation: no sudo, shell edits, or dependency installation.
set -Eeuo pipefail
package_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
prefix="${HOME}/.local"
build=true
usage() {
    cat <<'HELP'
Usage: ./install.sh [--prefix DIRECTORY] [--no-build]

Installs cx into PREFIX/bin and PREFIX/share/cx (default: ~/.local).
Builds the Docker image by default. --no-build copies the program only.
Existing managed installations are backed up; configuration is preserved.
An unrelated existing PREFIX/bin/cx is never overwritten.
HELP
}
while (($#)); do
    case "$1" in
        --prefix) (($# >= 2)) || { usage >&2; exit 2; }; prefix="$2"; shift 2 ;;
        --no-build) build=false; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'install: unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done
for tool in realpath install cp ln mktemp; do
    command -v "$tool" >/dev/null || { printf 'install: missing %s\n' "$tool" >&2; exit 1; }
done
prefix="$(realpath -m -- "$prefix")"
[[ "$prefix" != / && "$prefix" != *,* ]] || { printf 'install: invalid prefix\n' >&2; exit 1; }
install_root="$prefix/share/cx"
program="$install_root/program"
launcher="$prefix/bin/cx"
if [[ -e "$launcher" || -L "$launcher" ]]; then
    if [[ ! -L "$launcher" || "$(realpath -m -- "$launcher")" != "$program/bin/cx" || ! -f "$program/.cx-managed" ]]; then
        printf 'install: %s already exists and is not managed by this installer.\nMove it aside first; see docs/INSTALL.md for migration.\n' "$launcher" >&2
        exit 1
    fi
fi
if [[ -e "$program" || -L "$program" ]]; then
    [[ -d "$program" && ! -L "$program" && -f "$program/.cx-managed" ]] || {
        printf 'install: refusing to replace unmanaged %s\n' "$program" >&2; exit 1;
    }
fi
# Build before changing the installed program, so failed builds leave it usable.
if [[ "$build" == true ]]; then "$package_root/bin/cx" --build; fi
mkdir -p -- "$prefix/bin" "$install_root/config"
staging="$(mktemp -d "$install_root/.install.XXXXXX")"
cleanup() { [[ ! -d "$staging" ]] || rm -rf -- "$staging"; }
trap cleanup EXIT
for item in bin container docs VERSION README.md CHANGELOG.md uninstall.sh; do
    cp -R -- "$package_root/$item" "$staging/"
done
# Keep the user's configuration separate from replaceable program files.
if [[ ! -e "$install_root/config/config.toml" ]]; then
    install -m 0644 "$package_root/config/config.toml" "$install_root/config/config.toml"
fi
ln -s ../config "$staging/config"
printf '%s\n' "$(cat "$package_root/VERSION")" > "$staging/.cx-managed"
if [[ -d "$program" ]]; then
    backup="$(mktemp -d "$install_root/backup-$(date +%Y%m%d-%H%M%S).XXXXXX")"
    mv -- "$program" "$backup/program"
    printf 'Previous program saved to %s\n' "$backup/program"
fi
mv -- "$staging" "$program"
ln -sfn -- ../share/cx/program/bin/cx "$launcher"
printf 'Installed cx %s at %s\n' "$(cat "$program/VERSION")" "$launcher"
case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *) printf 'Add this to your shell profile, then open a new terminal:\n  export PATH=%q:"$PATH"\n' "$prefix/bin" ;;
esac
if [[ "$build" == false ]]; then printf 'Build next: %q --build\n' "$launcher"; fi
printf 'Then sign in: %q --login\nRun a project: %q /path/to/project\n' "$launcher" "$launcher"
