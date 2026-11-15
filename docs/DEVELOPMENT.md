# Development guide

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for issue and PR processes, then use
[architecture](ARCHITECTURE.md) to understand persistence and access boundaries.

## Local setup

Use a Linux/WSL2 checkout with Bash 4+, GNU coreutils, Git, Node.js 24/npm, and
Python 3.11+. Docker is needed for image/runtime checks, not offline suites.
Optional test-only tmux enables independent native terminal checks; it is not
a runtime requirement. Python rendering dependencies are bundled in `bin/vendor`.

```bash
npm ci --prefix container/mcp --ignore-scripts
node tests/smoke.mjs
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

## Documentation and releases

Keep examples generic; site-specific functions and scheduler policy belong to
the server. Document new options in help and `docs/USAGE.md`, setup changes in
`docs/INSTALL.md`, and architectural changes in `docs/ARCHITECTURE.md`.
Add distribution files to the package allowlist. Update `VERSION` and release
references only when preparing a requested release. Follow the
[release checklist](GITHUB.md#release-checklist); never publish a used portable bundle.
