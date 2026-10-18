#!/usr/bin/env bash
# Remove only program files owned by this installer. Retain all user data.
set -Eeuo pipefail
prefix="${HOME}/.local"
case "${1:-}" in
    --prefix) [[ $# == 2 ]] || exit 2; prefix="$2" ;;
    -h|--help)
        printf 'Usage: ./uninstall.sh [--prefix DIRECTORY]\nPreserves configuration, credentials, environments, backups, and Docker images.\n'; exit 0 ;;
    '') ;;
    *) printf 'uninstall: unknown option\n' >&2; exit 2 ;;
esac
prefix="$(realpath -m -- "$prefix")"
[[ "$prefix" != / ]] || exit 1
program="$prefix/share/cx/program"
launcher="$prefix/bin/cx"
[[ -d "$program" && ! -L "$program" && -f "$program/.cx-managed" ]] || {
    printf 'uninstall: no managed installation at %s\n' "$program" >&2; exit 1;
}
if [[ -L "$launcher" && "$(realpath -m -- "$launcher")" == "$program/bin/cx" ]]; then
    rm -- "$launcher"
fi
rm -rf -- "$program"
printf 'Removed cx program. Configuration and user data were retained.\n'
