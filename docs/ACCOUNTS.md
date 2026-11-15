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
The wrapper stops parsing at `--` and consumes that delimiter before invoking the
native CLI. For Claude's own named subagent option, use
`cx --agent claude --account work . -- --agent reviewer`. The native CLI receives
`--agent reviewer` as an option. To pass a native end-of-options delimiter as well,
use `-- --`, for example `cx --agent claude --account work . -- -- "--agent literal"`
to treat `--agent literal` as prompt text. Pass native conversation
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

Different accounts can run **distinct** conversations concurrently. Supported
resume operations use the selected account's credentials and remain subject to
native account ownership restrictions (see below). No cross-CLI conversion, account attribution
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
source precedence and managed restrictions apply. Additional-directory discovery
loads `CLAUDE.md` but omits `AGENTS.md`. An ephemeral `.claude/CLAUDE.md` therefore
imports `main/AGENTS.md` and `main/.claude/AGENTS.md` when present. Native memory
loading resolves relative imports from the original file, applies exclusions and
managed-only settings, and deduplicates files already imported or symlinked from
`CLAUDE.md`. Both instruction files can load together without duplicate content.
Project MCP is passed through native `--mcp-config`; user MCP remains enabled.
The wrapper writes only the container's ephemeral import file, never project
files or copies of their instruction text.

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

### Shared Codex Resume Picker

Codex **0.169.0** scopes its native picker to the current ChatGPT account and
workspace for account-scoped conversations. This does not necessarily prevent
resuming the conversation directly by ID: the user confirmed direct cross-account
subscription resume works on their installation, although the second account's
native picker omits the session. The earlier blanket claim that cross-account
subscription resume was blocked was incorrect.

For managed accounts, interactive `cx ... resume` now opens cx's shared-history
picker. It calls Codex's supported `thread/list` API with `currentAccountOnly:false`,
displays 20 recent conversations per page, and passes the selected UUID to native
`codex resume`. Enter a number to choose, `n`/`p` to change pages, or `q` to cancel.
The listing helper never resumes a thread or submits a model request. Native Codex
retains the selected credentials, permissions, ownership checks and exit status.

```bash
cx --agent codex --account second /path/to/project resume
cx --agent codex --account second /path/to/project resume --all
cx --agent codex --account second /path/to/project resume SESSION_ID
```

The picker filters by Codex's current directory unless `--all` is supplied. Include
`--include-non-interactive` to show scripted sessions too. Explicit IDs, `--last`,
remote connections, unrecognized picker options, noninteractive launches, and
legacy `CX_CODEX_HOME` sessions retain native behavior. The in-session `/resume`
command also remains the native picker. A failed listing reports an error without
starting a conversation. Cancellation never starts native resume. Rebuild the
image to include the new helper.

Some installations enable Codex's native resume ownership check. In that case,
the shared picker can show a conversation that native `codex resume` then rejects
as belonging to a different identity. cx preserves that rejection; it never removes
creator tags, disables the check or impersonates another client to resume.

The earlier loopback test used custom-provider/API-style fixture credentials and
an unfiltered storage query; it did not establish subscription-picker behavior.
A separate native regression uses synthetic ChatGPT identities and immutable
account-scoped rollout fixtures. It verifies native filtered discovery, cx shared
discovery through the real listing helper, and rejection when the native ownership
check is enabled. Run it without Claude or real provider accounts:

```bash
CX_NATIVE_HISTORY=1 node tests/codex-account-history.mjs
```

Upstream references for the tested version: [native resume picker](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/resume_picker.rs),
[local account filtering](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/thread-store/src/local_history_account.rs),
and [resume ownership check](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/request_processors/thread_resume_account.rs).

Storage/flag references: [Codex configuration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs),
[Claude environment variables](https://code.claude.com/docs/en/env-vars),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude settings precedence](https://code.claude.com/docs/en/settings).

## Verification and Open Gates

`node tests/accounts.mjs` covers metadata, defaults, PTY selection/filtering and
cancellation, forwarding, auth routing, refresh/logout isolation, mount boundaries,
legacy compatibility, and task stdin/output/status using fake Docker/native CLIs.
The existing smoke suite additionally verifies legacy installs and both archives.
`node tests/codex-resume.mjs` covers shared-picker parsing, paging, cancellation,
early terminal input and native CLI handoff, including preserved account checks
and exit status.

For actual binaries, without provider credentials or model requests:

```bash
CX_NATIVE_HISTORY=1 CX_NATIVE_CLAUDE=/path/to/claude node tests/native-history.mjs
```

On 2026-11-15, Codex **0.169.0** passed shared-storage discovery/resume with
custom-provider/API-style fixture credentials and concurrent distinct conversation
writes against a loopback model simulator. Claude **2.1.323** passed corresponding
native discovery/resume checks with fixture API credentials. These tests validate
storage/transport compatibility, not subscription account policy; they do not
establish cross-account Codex subscription resume.

The native regression suite also verifies startup instructions for AGENTS-only
projects, both instruction files, explicit imports, symlinks, `.claude/AGENTS.md`,
native exclusions and managed-only memory settings, including projects with
spaces in their paths. It checks that each instruction appears once in the model
request and that startup does not edit the project. An escaped `--agent` is tested
with an actual native agent definition, rather than just checking forwarded args.

The user reported successful host validation with Codex **0.169.0** and Claude
**2.1.323**: `scripts/verify-docker.sh --build` passed for installed and portable
editions, including mounts, masking, host writes and persistent storage. Native
subscription login and status checks passed for both CLIs across separate
containers. Live sessions and interactive same-account resume pickers also
passed for both CLIs. These are user-reported host results; the host checkout
SHA was not supplied. The user subsequently confirmed direct resume by session
ID under a second, different ChatGPT account succeeds. After the picker update
and rebuild instructions, the user also confirmed the other account's session
is visible in the new cx shared-history picker and that selecting it successfully
continues the conversation using the second account.

Live API-key login/persistence checks are **skipped at the user's request** because
API keys are unavailable. They remain unverified, rather than passed; automated
API-key routing coverage still applies.

Actual subscription credential refresh, logout isolation, live Claude cross-account
discovery/resume and concurrent distinct conversations remain **open integration
gates**. Both shared-picker discovery and continuation passed on the user's host.
Direct cross-account Codex subscription resume passed on the user's installation;
availability elsewhere depends on native account restrictions. Native tmux checks
are skipped where tmux is unavailable. Do not interpret
simulator success as completion of those live checks. CX-1 stays open while the
remaining acceptance checks are outstanding.
