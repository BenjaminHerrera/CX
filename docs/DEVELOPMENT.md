# Development guide

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for issue and PR processes, then use
[architecture](ARCHITECTURE.md) to understand persistence and access boundaries.

For the multi-CLI/account update, follow the [v2 integration workflow](V2.md).
Implementation branches start from the current `origin/v2` head and PRs merge
into `v2`. The final `v2` → `main` PR waits for full integration validation.

## Local setup

Use a Linux/WSL2 checkout with Bash 4+, GNU coreutils, Git, Node.js 24/npm, and
Python 3.11+. Docker is needed for image/runtime checks, not offline suites.
Optional test-only tmux enables independent native terminal checks; it is not
a runtime requirement. Python rendering dependencies are bundled in `bin/vendor`.

```bash
npm ci --prefix container/mcp --ignore-scripts
node tests/smoke.mjs
node tests/accounts.mjs
node tests/remote-client.mjs
node tests/mcp.mjs
python3 -B tests/ssh_bridge.py
python3 -B tests/slurm_setup.py
python3 -B tests/screens.py
```

Use an existing named development environment when working inside cx. Obtain
permission before installing into a user's persistent environment; never use
Micromamba base for project packages. The npm command above installs locked
SDK dependencies in the checkout only. Do not commit `node_modules`.

To try the source launcher on a Docker host, use `./bin/cx --build`, then
`./bin/cx /path/to/disposable/project`. The top-level `./cx` is the portable
entry point and selects private bundle-local `data/`; choose a project outside
that bundle. Do not use real credentials for automated tests.

## CLI Account Development

Read [accounts and native history](ACCOUNTS.md) before changing selection, auth or
storage seams. `tests/accounts.mjs` uses fake CLIs and a PTY for picker/filtering,
credential refresh/logout isolation, argument boundaries and task I/O. The
existing smoke suite preserves explicit legacy-home behavior and verifies both
archives. Add new runtime sources to both Docker's context allowlist and the
release allowlist.

`CX_NATIVE_HISTORY=1 CX_NATIVE_CLAUDE=/path/to/claude node tests/native-history.mjs`
checks actual CLI resume and concurrent distinct writes with fixture auth against
a loopback model simulator. It uses disposable homes and never logs into providers.
Record exact versions and keep live subscription/API login and Docker checks as
open gates when unavailable. Claude SSH/MCP/Slurm integration belongs to CX-2.
The suite includes `tests/codex-account-history.mjs`, which can also run separately
with `CX_NATIVE_HISTORY=1`. It checks native subscription-identity filtering and
ownership rejection. Passing an API-style fixture test does not prove cross-account
ChatGPT subscription compatibility; the current native picker restriction remains
an explicit CX-1 blocker.

## Component map

| Files | Responsibility |
|---|---|
| `bin/cx`, `cx` | Host options, paths, Docker arguments; portable entry point |
| `container/Dockerfile`, `container/cx-entrypoint` | Image and process/environment startup |
| `container/cx-env` | Persistent workspace environment selection |
| `bin/cx-ssh-bridge.py`, `container/cx-remote` | Host SSH supervisor and container CLI client |
| `bin/cx_screen.py`, `bin/vendor/` | Terminal rendering and bundled libraries |
| `container/mcp/` | Stdio MCP adapter and locked npm dependencies |
| `bin/cx-slurm-setup.py`, `scripts/cx-interactive-hook.sh` | Per-alias remote setup and shell readiness |
| `config/config.toml` | Default Codex developer instructions |
| `install.sh`, `uninstall.sh`, `scripts/package.sh` | Managed installation, removal, source archives |

## Choosing validation

- **Launcher, paths, mounts, installation:** run `smoke.mjs`; use live Docker
  verification for changed container/mount behavior.
- **SSH transport, framing, handoff:** run `ssh_bridge.py` and `remote-client.mjs`.
  Keep one command owner, bounded output, and explicit unknown outcomes.
- **Terminal rendering/input:** run `screens.py` and `ssh_bridge.py`; use tmux
  checks when available, then test affected behavior in the real terminal.
- **MCP:** run `mcp.mjs` and `ssh_bridge.py`; rebuild the image when adapter
  sources or dependencies change. Do not edit the lockfile manually.
- **Slurm:** run `slurm_setup.py`, `ssh_bridge.py`, and `mcp.mjs`. Use fixtures
  routinely; live CPU/GPU allocation needs explicit authorization.
- **Documentation/packaging:** check local links and `git diff --check`; run
  `smoke.mjs` when changing distribution files or scripts.

The [maintenance guide](MAINTAINING.md) explains coverage and live checklists.
A skipped test is not a pass. Record the environment and limits of validation.

## Compatibility and failure behavior

Preserve installed and portable paths, saved settings, and local operation
without SSH dependencies. Do not silently weaken mounts or copy credentials
into releases. Changes to mounted individual files must support in-place edits.

Remote commands run in a stateful shell. Authentication stays with the user.
Poll tracked IDs after timeouts; never replay uncertain commands through another
transport. Readiness must match the Slurm job ID and startup token; check the
physical hostname separately. Remote mounts stay on the initial login host.

## GitHub titles and names

Use standard English title case for human-facing GitHub issue and pull request
titles, rule/ruleset names, workflow and job display names, and release titles.
Capitalize the first and last words and major words (nouns, pronouns, verbs,
adjectives, and adverbs). Keep articles, coordinating conjunctions, and short
prepositions lowercase unless they start or end the title. Do not simply
capitalize every word. Preserve acronyms and established spelling such as
`SSH`, `MCP`, `GPU`, `GitHub`, `Codex`, and `cx`.

Examples: `Fix SSH Session Switching`, `Add Support for Remote Files`,
`cx Main Protections`, and `Offline Checks`. Preserve any issue-template prefix,
such as `[Bug]: Fix SSH Session Switching`.

This convention applies to display text. Keep branch names, labels, file paths,
command names, and machine identifiers in their existing conventions. When
renaming a workflow/job or ruleset, update matching required-check contexts,
setup-script lookups, examples, and documentation together. Do not rename
existing GitHub objects solely as part of an unrelated change.

## Documentation and releases

Keep examples generic; site-specific functions and scheduler policy belong to
the server. Document new options in help and `docs/USAGE.md`, setup changes in
`docs/INSTALL.md`, and architectural changes in `docs/ARCHITECTURE.md`.
Add distribution files to the package allowlist. Update `VERSION` and release
references only when preparing a requested release. Follow the
[release checklist](GITHUB.md#release-checklist); never publish a used portable bundle.
