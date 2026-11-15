# CLI Accounts and Shared History

cx runs Codex and Claude Code from one image. Rebuild after upgrading:

```bash
cx --rebuild
cx accounts add --agent codex --account personal --auth subscription
cx accounts add --agent claude --account work --auth subscription
cx --agent codex --account personal --login
cx --agent claude --account work --login
cx --agent claude --account work /path/to/project
```

Creation records a name and authentication mode. It does not sign in, copy
credentials, or import existing native homes. Names contain 1–64 ASCII letters,
digits, dots, underscores or hyphens and start with a letter or digit. The same
name may exist once per CLI. `cx accounts list` shows names and modes, never
secrets; `--agent` filters the list. Adding an existing name fails.

## Selection and Automation

Every interactive launch without a complete `--agent`/`--account` pair shows a
numbered picker, even if only one account exists or an automation default is set.
`--agent` filters the picker; `q`, EOF, or Ctrl-C cancels. Selection options may
precede or follow the workspace. No account is created implicitly.

Scripts and redirected launches require a complete pair or a saved default:

```bash
cx accounts default --agent codex --account personal
cx . exec "Run the tests"
cx --agent claude . --account work exec "Explain the failures"
printf '%s\n' 'Summarize main/' | cx --agent claude --account work . exec -
```

Partial noninteractive selection must match the default; it never silently
selects a different CLI/account. Remove `automation-default` under `CX_DATA_HOME`
to clear it. Help, wrapper version, doctor, builds, Slurm setup, and `--shell`
do not select an account. Shells expose a separate empty persistent home rather
than managed account credentials; explicit legacy mode retains its home mount.

`exec` maps to Codex `exec` or Claude `--print`, preserving stdin, output, and
exit status. Native options stay native: `--profile` still belongs to Codex.
The wrapper stops parsing at `--`. For Claude's own named subagent option, use
`cx --agent claude --account work . -- --agent reviewer`. Pass native conversation
resume options, for example:

```bash
cx --agent codex --account personal . resume
cx --agent claude --account work . --resume
cx --agent claude --account work . exec --resume SESSION_ID "Continue"
```

## Authentication

`--login`, `--auth-status`, and `--logout` route only to the selected profile.
Subscription profiles use Codex device authentication or Claude's native login.
Complete the provider's login yourself. Profiles with `--auth api-key` use
Codex's native `login --with-api-key` stdin flow or Claude's hidden terminal
prompt. Codex accepts a securely supplied pipe; Claude deliberately requires a
terminal. Do not put keys in command arguments or repository files.

Claude API keys are stored with mode 0600 inside the selected private home and
loaded into its process environment. Logout removes that key and invokes native
logout. Subscription profiles never load the saved API-key file. Native credential
refresh/logout can replace files atomically because the whole selected home is
mounted. Host provider authentication variables are not forwarded into Docker;
the adapter also clears inherited provider keys/tokens before choosing auth.

## Storage and Isolation

Installed data defaults to `~/.local/share/cx/data`; portable data defaults to
`bundle/data`. Set `CX_DATA_HOME` for another location. `CX_ENV_HOME` remains the
separate environment store. Profiles and shared history have private host
permissions:

```text
data/
├── profiles/{codex,claude}/NAME/
│   ├── auth-mode
│   └── home/                  # credentials, settings, plugins and caches
├── history/codex/             # sessions, archives, index/history and SQLite
├── history/claude/projects/   # native transcripts and project metadata
└── automation-default        # CLI and account names only
```

Only the selected `home/` mounts at `/codex-home` or `/claude-home`. Only that
CLI's history mounts at `/cx-history`. No parent profile directory or other
account home is mounted. Workspace/additional mounts cannot overlap managed
data or native credential directories, including through symlink aliases.
Accounts isolate mounted authentication/configuration, not Unix host users or
conversation content. Everyone using these profiles can read the shared history.

Codex homes link `sessions`, `archived_sessions`, `thread-writer-locks`,
`history.jsonl`, and `session_index.jsonl` to the shared mount. `CODEX_SQLITE_HOME`
selects its shared `sqlite/` directory, including WAL sidecars. Claude homes link
their native `projects/` directory, including transcript indexes, subagent
transcripts, and project memory, to the shared mount. Claude's configuration and
credentials remain under private `CLAUDE_CONFIG_DIR=/claude-home`. History links
are container paths; use the host's `history/` tree for backups. Unexpected
existing history paths fail instead of being moved or overwritten.

Different accounts can run **distinct** conversations concurrently. Resume uses
the selected account's credentials. No cross-CLI conversion, account attribution
rewriting, raw database merging, provider-policy bypass, or simultaneous editing
of one conversation is provided. Native cleanup/archive/delete actions can affect
the shared history; use the CLI's normal controls and back up the history tree
with all writers stopped.

An explicitly set `CX_CODEX_HOME` selects legacy Codex mode with no managed
picker/history sharing. It cannot be combined with managed `--account` or Claude.
Existing `~/.codex`, `~/.claude`, and `~/.claude.json` are left untouched. To retain
an older portable home, explicitly set `CX_CODEX_HOME=/path/to/bundle/data/codex`.

## Claude Project Context and Compatibility

Both CLIs start at `/workspace`, preserving `main/`, `cx-external/`, `remote/`,
ignore masks, added files, environment selection, and resource limits. Claude
adds `main/` and enables native additional-directory instruction discovery. Its
project/local settings are linked into ephemeral `/workspace/.claude` so native
source precedence and managed restrictions apply. Project MCP is passed through
native `--mcp-config`; user MCP remains enabled. The wrapper does not edit the
repository or copy project instruction text into another memory file.

Claude receives the common cx guidance as an addition to its default prompt.
`--system-prompt-snapshot off` ensures resume renders current session guidance.
The image defaults to Claude **2.1.323** and accepts `CX_CLAUDE_VERSION` at build
time; `CX_CODEX_VERSION` retains its existing override. Managed Codex history
requires Codex 0.169.0 or later; older versions fail before launching a session. Automatic and manual Claude
self-updates are disabled. Incompatible images fail with a rebuild instruction.
Claude permission bypass requires a non-root invoking UID. Claude SSH/MCP/Slurm
parity is tracked by [CX-2](https://github.com/BenjaminHerrera/CX/issues/2); Claude
SSH launches fail clearly until that integration is implemented. Codex SSH uses
the selected profile and retains its existing transport and authentication rules.

Storage/flag references: [Codex configuration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs),
[Claude environment variables](https://code.claude.com/docs/en/env-vars),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude settings precedence](https://code.claude.com/docs/en/settings).

## Verification and Open Gates

`node tests/accounts.mjs` covers metadata, defaults, PTY selection/filtering and
cancellation, forwarding, auth routing, refresh/logout isolation, mount boundaries,
legacy compatibility, and task stdin/output/status using fake Docker/native CLIs.
The existing smoke suite additionally verifies legacy installs and both archives.

For actual binaries, without provider credentials or model requests:

```bash
CX_NATIVE_HISTORY=1 CX_NATIVE_CLAUDE=/path/to/claude node tests/native-history.mjs
```

On 2026-11-15, Codex **0.169.0** and Claude **2.1.323** passed native cross-account
resume with selected fixture credentials and concurrent distinct conversation
writes against a loopback model simulator. This validates native storage/transport
compatibility, not provider subscription or billing policy.

Live Docker build/mount behavior, interactive native history pickers, subscription
and API-key login/refresh/persistence with consenting accounts remain **open
integration gates**. Native tmux checks are skipped where tmux is unavailable.
Do not interpret offline success as completion of those live checks.
