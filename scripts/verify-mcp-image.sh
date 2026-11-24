#!/usr/bin/env bash
# Real Docker checks; no provider login, real SSH, remote writes or allocations.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
build=false
case "${1:-}" in
    --build) build=true ;;
    '') ;;
    -h|--help)
        printf 'Usage: scripts/verify-mcp-image.sh [--build]\n--build builds a disposable image from 0600 MCP source files.\nOtherwise tests CX_IMAGE (default local/codex-isolated:latest).\nUses arbitrary non-root image UID and both packaged launchers; no provider/SSH access.\n'; exit 0 ;;
    *) printf 'verify-mcp: unknown option\n' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || exit 2
[[ "$(id -u)" != 0 ]] || { printf 'verify-mcp: run as a non-root Docker user (Claude requires it).\n' >&2; exit 1; }
command -v docker >/dev/null || { printf 'verify-mcp: Docker is unavailable; run on your Docker host.\n' >&2; exit 1; }
docker info >/dev/null
fixture="$(mktemp -d "$root/.cx-live-mcp.XXXXXX")"
image="${CX_IMAGE:-local/codex-isolated:latest}"
owned_image=false
cleanup() {
    if [[ "$owned_image" == true ]]; then docker image rm "$image" >/dev/null 2>&1 || :; fi
    rm -rf -- "$fixture"
}
trap cleanup EXIT
if [[ "$build" == true ]]; then
    image="local/cx-mcp-permissions:$(id -u)-$$"
    mkdir -p "$fixture/context/mcp"
    for file in Dockerfile .dockerignore cx-entrypoint cx-env cx-remote cx-agent cx-gh cx-codex-resume.mjs cx-claude-config.mjs cx-guidance.txt mcp/package.json mcp/package-lock.json mcp/server.mjs; do
        cp -- "$root/container/$file" "$fixture/context/$file"
    done
    chmod 0600 "$fixture/context/mcp/"*
    owned_image=true
    docker build --build-arg "CODEX_VERSION=${CX_CODEX_VERSION:-latest}" \
        --build-arg "CLAUDE_VERSION=${CX_CLAUDE_VERSION:-2.1.323}" -t "$image" "$fixture/context"
fi
docker image inspect "$image" >/dev/null
cp "$root/container/cx-mcp-check.mjs" "$fixture/check.mjs"
cat >"$fixture/verify.mjs" <<'JS'
import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert/strict';
import {checkAdapter} from '/check.mjs';
assert.notEqual(process.getuid(),0);
for(const file of ['/opt/cx-mcp/server.mjs','/opt/cx-mcp/package.json','/opt/cx-mcp/package-lock.json']) {
  assert.equal(fs.statSync(file).uid,0);
  fs.accessSync(file,fs.constants.R_OK);
  assert.throws(()=>fs.accessSync(file,fs.constants.W_OK));
}
const calls=[],socket='/tmp/fixture.sock';
const bridge=net.createServer(client=>{
  let buffer='';
  client.on('data',data=>{
    buffer+=data;if(!buffer.includes('\n'))return;
    calls.push(JSON.parse(buffer.split('\n')[0]));
    client.end(JSON.stringify({type:'status',ready:true})+'\n');
  });
});
try {
  await new Promise(resolve=>bridge.listen(socket,resolve));
  for(const agent of ['codex','claude']) {
    await checkAdapter({status:true,env:{...process.env,CX_AGENT:agent,CX_SSH_SOCKET:socket}});
    console.log(`PASS: installed shared adapter discovery/status for ${agent} configuration, UID ${process.getuid()}`);
  }
  assert.deepEqual(calls,[{op:'status'},{op:'status'}]);
} finally {bridge.close();}
JS
chmod 0644 "$fixture/check.mjs" "$fixture/verify.mjs"
docker_args=(run --rm --user 23456:23456 --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges=true --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777
    --mount "type=bind,src=$fixture/check.mjs,dst=/check.mjs,readonly" --entrypoint node)
docker "${docker_args[@]}" --mount "type=bind,src=$fixture/verify.mjs,dst=/verify.mjs,readonly" "$image" /verify.mjs
# Deliberately broken installed files must fail without credentials or a bridge.
printf 'invalid javascript !\n' >"$fixture/bad.mjs"
for failure in permission load; do
    if [[ "$failure" == permission ]]; then chmod 000 "$fixture/bad.mjs"; else chmod 0644 "$fixture/bad.mjs"; fi
    if docker "${docker_args[@]}" --mount "type=bind,src=$fixture/bad.mjs,dst=/opt/cx-mcp/server.mjs,readonly" \
        "$image" /check.mjs >"$fixture/result" 2>&1; then
        printf 'verify-mcp: broken adapter unexpectedly passed\n' >&2; exit 1
    fi
    grep -q "adapter_$failure:" "$fixture/result"
    printf 'PASS: installed adapter_%s diagnosis\n' "$failure"
done
chmod 0600 "$fixture/bad.mjs"
# Exercise the actual packaged launch path for each CLI, including its preflight.
"$root/scripts/package.sh" --output "$fixture/releases"
version="$(cat "$root/VERSION")"
for edition in install portable; do
    tar -xzf "$fixture/releases/cx-$version-$edition.tar.gz" -C "$fixture"
    if [[ "$edition" == install ]]; then
        "$fixture/cx-$version-install/install.sh" --no-build --prefix "$fixture/prefix"
        launcher="$fixture/prefix/bin/cx"
    else launcher="$fixture/cx-$version-portable/cx"; fi
    mkdir -p "$fixture/project" "$fixture/bridge"
    for agent in codex claude; do
        run=(env -u CX_CODEX_HOME -u CX_SSH_MOUNT_PATH -u CX_SSH_MOUNT_MODE
            "CX_SSH_MCP=1" "CX_IMAGE=$image" "CX_DATA_HOME=$fixture/$edition-data"
            "CX_ENV_HOME=$fixture/$edition-environments" "CX_CONFIG_DIR=$fixture/cx-$version-$edition/config")
        "${run[@]}" "$launcher" accounts add --agent "$agent" --account fixture --auth subscription
        "${run[@]}" "CX_SSH_BRIDGE_DIR=$fixture/bridge" CX_SSH_HOST=fixture \
            "$launcher" "$fixture/project" --agent "$agent" --account fixture --version
        printf 'PASS: %s %s startup and preflight (no authentication/model request)\n' "$edition" "$agent"
    done
done
printf 'MCP image checks passed. Native CLI tool-use, provider login and live SSH were not tested.\n'
