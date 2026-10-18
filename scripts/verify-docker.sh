#!/usr/bin/env bash
# Exercise clean install and portable releases with a real local Docker daemon.
# Uses disposable data and does not authenticate or send a model request.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "${1:-}" in
    --build) build=true ;;
    '') build=false ;;
    -h|--help)
        printf 'Usage: scripts/verify-docker.sh [--build]\nTests both released editions using a local Docker daemon.\n--build builds the configured CX_IMAGE first; otherwise it must exist.\nDoes not sign in. Disposable fixtures are created beside the source.\n'; exit 0 ;;
    *) printf 'verify: unknown option\n' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || exit 2
command -v docker >/dev/null || { printf 'verify: Docker is not installed or is not in PATH. Run this on your Docker host.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'verify: the local Docker daemon is not accessible.\n' >&2; exit 1; }
if [[ "$build" == true ]]; then "$root/bin/cx" --build; fi
image="${CX_IMAGE:-local/codex-isolated:latest}"
docker image inspect "$image" >/dev/null 2>&1 || {
    printf 'verify: image %s is missing; rerun with --build.\n' "$image" >&2; exit 1;
}
fixture="$(mktemp -d "$root/.cx-live.XXXXXX")"
cleanup() { rm -rf -- "$fixture"; }
trap cleanup EXIT
version="$(cat "$root/VERSION")"
"$root/scripts/package.sh" --output "$fixture/releases"
tar -xzf "$fixture/releases/cx-$version-portable.tar.gz" -C "$fixture"
tar -xzf "$fixture/releases/cx-$version-install.tar.gz" -C "$fixture"
prefix="$fixture/install prefix"
"$fixture/cx-$version-install/install.sh" --no-build --prefix "$prefix"
for edition in install portable; do
    project="$fixture/$edition project"
    shared="$fixture/$edition shared"
    mkdir -p -- "$project/hidden" "$shared"
    printf '%s\n' '.private' hidden > "$project/.codexignore"
    printf '%s\n' 'private fixture value' > "$project/.private"
    printf '%s\n' 'private fixture value' > "$project/hidden/original"
    printf '%s\n' 'shared fixture value' > "$shared/visible"
    if [[ "$edition" == install ]]; then
        command=(env -u CX_ENV_NAME -u CX_CONFIG_DIR
            "CX_CODEX_HOME=$fixture/install-data/codex"
            "CX_ENV_HOME=$fixture/install-data/environments"
            "$prefix/bin/cx")
    else
        command=(env -u CX_CODEX_HOME -u CX_ENV_HOME -u CX_ENV_NAME -u CX_CONFIG_DIR
            "$fixture/cx-$version-portable/cx")
    fi
    # Normal launch exercises system config, all limits, and read-only mounts.
    "${command[@]}" "$project" --version
    # The shell accepts stdin, letting us test real mount contents without login.
    (
        cd -- "$project"
        "${command[@]}" --shell --add-dir "$shared" <<'CHECK'
set -Eeuo pipefail
test "$PWD" = /workspace
test ! -s /workspace/.private
test ! -s /workspace/.codexignore
test ! -e /workspace/hidden/original
if touch /workspace/hidden/should-fail 2>/dev/null; then
    printf 'verify: ignored directory was writable\n' >&2; exit 1
fi
external=(/cx-external/*)
test "${#external[@]}" = 1
grep -q 'shared fixture value' "${external[0]}/visible"
printf '%s\n' written-in-container > /workspace/verified
printf '%s\n' written-in-container > "${external[0]}/verified"
printf '%s\n' persisted > /cx-env/verification-marker
cx-env active
micromamba --version
CHECK
        "${command[@]}" --shell <<'CHECK'
set -Eeuo pipefail
grep -q persisted /cx-env/verification-marker
CHECK
    )
    grep -q written-in-container "$project/verified"
    grep -q written-in-container "$shared/verified"
    grep -q 'private fixture value' "$project/.private"
    grep -q 'private fixture value' "$project/hidden/original"
    printf 'PASS: %s edition: container launch, mounts, masking, host writes, persistent storage\n' "$edition"
done
"$fixture/cx-$version-install/uninstall.sh" --prefix "$prefix"
printf 'Docker verification passed for both editions on this host. Live authentication and model requests were not tested.\n'
