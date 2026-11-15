#!/usr/bin/env bash
# Apply the reviewed main ruleset using the host's authenticated GitHub CLI.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo="${1:-BenjaminHerrera/CX}"
[[ $# -le 1 && "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    printf 'Usage: scripts/configure-github.sh [OWNER/REPO]\n' >&2; exit 2;
}
command -v gh >/dev/null || { printf 'Run on a host with GitHub CLI installed and authenticated.\n' >&2; exit 1; }
gh auth status >/dev/null
# Require an actual successful check on the current main commit before enforcing it.
passed="$(gh api "repos/$repo/commits/main/check-runs" --paginate --jq '.check_runs[] | select(.name == "Offline checks" and .conclusion == "success") | .id')"
[[ -n "$passed" ]] || {
    printf 'Publish the CI workflow to main and wait for Offline checks to pass, then rerun. No rules changed.\n' >&2; exit 1;
}
existing="$(gh api "repos/$repo/rulesets" --paginate --jq '.[] | select(.name == "cx main protections") | .id')"
[[ -z "$existing" ]] || {
    printf 'The cx main protections ruleset already exists (ID %s). Review it in GitHub Settings instead of overwriting it.\n' "$existing" >&2; exit 1;
}
gh api --method POST "repos/$repo/rulesets" \
    --input "$root/.github/main-ruleset.json" \
    --jq '{id, name, enforcement, rules}'
printf 'Verify the active rules at https://github.com/%s/rules\n' "$repo"
