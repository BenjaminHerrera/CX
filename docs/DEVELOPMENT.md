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
node tests/sessions.mjs
node tests/session-menu.mjs
python3 -B tests/session_menu.py
node tests/import-sessions.mjs
node tests/codex-resume.mjs
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
credential refresh/logout isolation, safe profile removal, argument boundaries
and task I/O. Removal checks cover duplicate names, automation defaults,
shared-history preservation, and refusal of symlinked storage. The
existing smoke suite preserves explicit legacy-home behavior and verifies both
archives. Add new runtime sources to both Docker's context allowlist and the
release allowlist.

`CX_NATIVE_HISTORY=1 CX_NATIVE_CLAUDE=/path/to/claude node tests/native-history.mjs`
checks actual CLI resume and concurrent distinct writes with fixture auth against
a loopback model simulator. It uses disposable homes and never logs into providers.
Record exact versions and keep live subscription/API login and Docker checks as
open gates when unavailable. Claude SSH/MCP/Slurm live integration validation belongs to CX-2.
The suite includes `tests/codex-account-history.mjs`, which can also run separately
with `CX_NATIVE_HISTORY=1`. It checks native subscription-identity filtering and
ownership rejection with the native check enabled, plus the production shared
history listing client. `node tests/codex-resume.mjs` covers the cx picker and
native CLI handoff. Passing an API-style fixture test does not prove subscription
account compatibility; report native restrictions and host tests separately.

Session deletion uses `container/cx-sessions.mjs`, mounted read-only by the host
launcher in a network-disabled container with histories only. It reuses the
Codex app-server client and native `thread/delete`; never replace that operation
with direct database writes. `tests/sessions.mjs` covers file/index isolation,
collision handling, native failures and unsafe paths. Set `CX_NATIVE_HISTORY=1`
to add real Codex fixture deletion, SQLite cleanup, spawned descendants and
preservation of similar UUIDs in the other storage namespace. Keep the exact
lookup guards: native 0.169.0 can fuzzy-match a different rollout when an ID is
absent from active or archived storage (see the [native lookup implementation](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/rollout/src/list.rs)). The helper reads the single native state
database for descendant IDs and refuses conflicting database versions.

`scripts/import-sessions.mjs` is a host Node 24 maintenance utility, also
installed as `program/bin/cx-import-sessions.mjs`. It uses only built-in modules,
copies allowed history paths, snapshots native SQLite for read-only integrity
checks, and never merges databases or imports credentials. Additions need
source/package coverage, not Docker build inputs. `tests/import-sessions.mjs`
checks dry runs, repeat imports, conflicts/dependencies, indexes, compressed
rollouts, independent copies, path boundaries, source preservation and WAL
snapshots. SQLite cache rows are not evidence that a rollout is unimportable.
Check backing files, ordinals, projection offsets and ancestor lengths; require
`--skip-unavailable` before omitting unavailable histories and their descendants.
`CX_NATIVE_HISTORY=1` adds real Codex discovery in an initialized shared store,
plus paginated resume that compares native turns/items before and after import,
with temporary homes and no provider login or model requests. Codex's
[materialization pipeline](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/thread-store/src/local/thread_history_materialization.rs)
rebuilds these projections from durable rollout records.

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


## Session Menu Development

`bin/cx_sessions.py` owns the menu model, saved pane, keyboard actions and bounded
asynchronous worker. `bin/cx-session-supervisor.py` reuses the PTY/screen plumbing
for local sessions without invoking SSH or loading its configuration. The SSH
supervisor retains its existing transport and calls the same menu controller.
Opening the menu changes display/input routing, not remote focus/readiness.

`container/cx-session-menu.mjs` runs as a history-only, network-disabled utility,
reusing `cx-sessions.mjs` for deletion and `cx-codex-resume.mjs` for native RPC.
Keep mutation requests bound to an explicit CLI/UUID. Never replay an initial
task during handoff, kill a potentially busy assistant to switch, or infer an
active ID from recent history. Recheck remote ownership at handoff, not just at
selection. Idle ready allocations remain owned by the same bridge.

Run `session-menu.mjs` for native pagination/naming and history safety fixtures;
`CX_NATIVE_HISTORY=1` adds real Codex naming/discovery with a disposable rollout
and no provider requests. `session_menu.py` covers keyboard/modal routing,
cursor preservation, Unicode, resize, clean/failed/busy handoff, helper startup failure, retained
allocation identity and a real local PTY draft-restoration check. Run existing
screens/SSH/removal/account suites after changing those seams. Fixtures do not
establish real Docker, Claude live resume, Windows Terminal selection/paste or
site scheduler behavior. See `docs/CX7-VALIDATION.md` for remaining live gates.

The resume-style menu uses a local filtered view keyed by CLI/UUID. Search never
reads chat previews. Keep internal-source filtering separate from display names;
F2 explicitly requests reviewer/subagent rows and labels them. Test search-mode
key isolation, filter/sort/density changes and narrow layouts in session_menu.py,
and native request/source filtering in session-menu.mjs. Native helper mutations
retain exact IDs even when the visible list is filtered.
