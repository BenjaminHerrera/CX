# CLI Accounts and Shared History

[Handbook home](README.md) · [First account](GETTING-STARTED.md#choose-your-first-account) · [Session walkthrough](SESSIONS.md) · [Import walkthrough](IMPORTING.md)

This reference explains authentication, storage, native compatibility and
maintenance details. Use the linked walkthroughs for everyday tasks.

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

## Import Existing Native Sessions

From a source checkout or extracted release, run this on the host with Node 24:

```bash
# Stop native Codex/Claude and CX sessions before either command.
node scripts/import-sessions.mjs --dry-run
node scripts/import-sessions.mjs
```

The script copies file-backed native conversations into CX's shared history.
It leaves originals in place and does not import credentials, settings, plugins,
private caches, Claude project memory, account profiles or automation defaults.
Sign in to a CX account separately. This needs no Docker, provider access or
additional npm packages. Installed editions also include the standalone script
at `PREFIX/share/cx/program/bin/cx-import-sessions.mjs` (default prefix `~/.local`).

Defaults are `CODEX_HOME` or `~/.codex`, `CLAUDE_CONFIG_DIR` or `~/.claude`, and
`CX_DATA_HOME` or `~/.local/share/cx/data`. For portable mode, **explicitly point
at the bundle's `data/` directory**. Override paths or import just one CLI:

```bash
node scripts/import-sessions.mjs --agent codex --codex-home /backup/.codex \
  --data-home /path/to/portable-cx/data --dry-run
node scripts/import-sessions.mjs --agent claude --claude-home /backup/.claude
```

Codex imports active and archived rollouts (including Zstandard-compressed
files), plus matching `history.jsonl` and `session_index.jsonl` rows. Claude
imports project transcripts, their session/subagent folders and matching
`sessions-index.json` entries; imported index paths point at CX's shared mount.
IDs, transcript bytes, original project paths and account attribution stay
unchanged. These remain native conversations within their original CLI; no
Codex/Claude conversion or provider ownership bypass occurs.

Identical content is skipped, including an existing Codex rollout in a different
archive location or compression format. Existing CX names/index entries win.
A different version of the same session causes the default import to stop
before publishing files. `--on-conflict skip` keeps those CX sessions and imports
the rest; dependent Codex fork histories are also skipped when their source
ancestor conflicts. No overwrite option is provided. Symlinked history entries,
overlapping native/CX roots, malformed indexes and missing ancestor rollouts
are refused. New files/directories use private permissions.

SQLite databases are **never copied or merged**. Legacy and paginated Codex
sessions are supported when their durable rollouts and ancestor history are
available. SQLite history records alone do not make a session unimportable:
native Codex rebuilds its history projections from rollouts when resuming.
The importer checks private state/WAL snapshots, complete JSONL records,
paginated ordinals, current rollout references, cached byte checkpoints and
ancestor prefix lengths before
copying. These checks use decompressed byte lengths for compressed rollouts.

If a backing file is missing or shorter than its cached history, the default
import stops before publishing any files and reports the affected IDs. Restore
the complete rollouts, or explicitly import only recoverable conversations:

```bash
node scripts/import-sessions.mjs --skip-unavailable --dry-run
node scripts/import-sessions.mjs --skip-unavailable
```

Skipped sessions and dependent fork histories are reported individually; their
source data is left untouched. Unknown transcript formats and malformed JSON still
fail instead of being guessed. SQLite-only display settings, such as paginated
thread names and pins that are absent from exported indexes, are not migrated.
Existing CX sessions with SQLite history but missing backing rollouts are
treated as conflicts; incoming files cannot silently replace that history.

A separate database location is read from `CODEX_SQLITE_HOME`, or from
`--codex-sqlite-home DIR`. When `--codex-home` is explicit, the SQLite default is
that selected home. Existing CX SQLite metadata is left to native discovery;
Codex 0.169.0 discovery in an initialized store and reconstruction of paginated
user/assistant history on native resume are tested with plain and compressed
rollouts. Provider account restrictions still apply.

Keep all writers stopped for the whole import. The script stages copies, checks
for changes and holds a lock against other imports; it does not lock native or
CX clients. An interrupted publish can leave a subset imported; with writers
stopped, rerun to finish safely. A killed process can leave `.import-sessions.lock`
and a private `.import-sessions-*` staging directory in the chosen data root.
Confirm the importer has exited before removing its leftover lock/staging files.

Reopen CX after importing. Original project paths may differ from `/workspace`;
use Codex `resume --all` or Claude's explicit `--resume SESSION_ID` when the
native picker filters by project. Native account restrictions still apply.

## Remove an Account

Close sessions using the profile, then run on the host:

```bash
cx accounts remove work
# If the name exists under both CLIs, select which one to remove:
cx accounts remove work --agent claude
```

The command deletes the selected profile's locally stored credentials, settings,
plugins and caches. Shared conversation history and other profiles are preserved.
A matching automation default is cleared; a default for another profile is kept.
`--account work` is also accepted instead of the positional name. Missing or
ambiguous names fail without deleting a profile. Symlinked profile directories
are refused. Removal works without Docker or provider access, does not stop
running sessions, and does not invoke provider logout or revoke remote tokens.
Use the profile's `--logout` action first if you also want native logout.

## Remove a Session

Stop all sessions for the affected CLI, then run on the host:

```bash
cx sessions remove 01234567-89ab-cdef-0123-456789abcdef
cx sessions remove 01234567-89ab-cdef-0123-456789abcdef --agent claude
```

Use the full UUID from the CLI's session information or transcript filename.
The updated CX Codex resume picker also shows full IDs; rebuild the image to
update that picker. Shortened IDs and paths are refused. CX discovers the CLI
automatically; if the same UUID exists under both CLIs, `--agent` is required.

Deletion is permanent and affects **all CX accounts sharing that CLI's history**.
Back up `CX_DATA_HOME/history` with writers stopped first if you need recovery.
Codex uses native `thread/delete` to remove transcripts, SQLite metadata and
spawned descendants, plus matching shared history/index rows. Native reference
and writer checks remain in effect. Claude removal deletes the matching project
transcripts, their session/subagent folders and matching session-index entries.
Other conversations, account profiles, project files and shared project memory
are preserved. Private profile logs/caches and provider-side data are outside
this command's scope.

Sessions menu deletion uses the same stable Codex home as history listing.
Each fresh maintenance container recreates its shared history links before
resolving the stored transcript path. This avoids missing-path errors such as
`ENOENT: no such file or directory, lstat '/codex-home/sessions'` when deleting
a conversation that was listed by an earlier helper container.

The command needs Docker and an existing CX image, but no login, network access,
host Node/Python, or account selection. It mounts only managed shared history
and read-only maintenance code. Installed, portable and `CX_DATA_HOME` paths
are supported; explicit legacy `CX_CODEX_HOME` is refused. It does not stop
running sessions. Avoid concurrent writers throughout deletion.

Symlinked history and invalid Claude index files are refused. Codex deletion
requires the native `thread/delete` API (tested with 0.169.0); unsupported images
fail rather than falling back to database edits. Multiple `state_*.sqlite`
versions are refused because their relationship records may disagree: back up
the history and retain the state database used by your installed Codex version
before retrying. A failure during native deletion or file updates can leave a
partial result. Inspect the history and error before taking further action;
CX never retries an uncertain deletion automatically.

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
Claude permission bypass requires a non-root invoking UID. Claude SSH/MCP/Slurm integration reuses the existing bridge and requires the
live validation tracked by [CX-2](https://github.com/BenjaminHerrera/CX/issues/2). Codex SSH uses
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
`node tests/sessions.mjs` covers removal, cross-CLI collisions, history/index
cleanup and refusal of unsafe paths. `CX_NATIVE_HISTORY=1 node tests/sessions.mjs`
also verifies deletion with a real installed Codex binary, temporary transcripts
and SQLite databases, without provider login or model requests.
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
continues the conversation using the second account. Codex concurrent distinct
conversations and logout isolation also passed: both accounts operated independently,
and logging out the second profile left the first authenticated.

Live API-key login/persistence checks are **skipped at the user's request** because
API keys are unavailable. They remain unverified, rather than passed; automated
API-key routing coverage still applies.

Live Claude cross-account discovery/resume, concurrency between different accounts,
and logout isolation between different accounts are **skipped** because the user
has no second account with Claude Code access. These remain unverified by live
accounts; fixture coverage remains available.

Actual automatic subscription credential refresh remains **unverified** for both
CLIs. Direct cross-account Codex subscription resume and the shared picker passed
on the user's installation; availability elsewhere depends on native account
restrictions. Native tmux checks are skipped where tmux is unavailable. Do not
interpret simulator success or a requested skip as a live pass. CX-1 stays open
and the PR stays draft until explicitly approved for a status change or merge.


## Session Names and Menu Safety

`cx sessions select [PROJECT]` and **Ctrl-] s** open the same named menu for both
CLIs. It lists native project/time/UUID context, never chat snippets as names.
The resume-style layout includes `/` search, Tab/Left/Right controls for CLI,
active/archived status and updated/name sorting, plus Ctrl-O row density.
Guardian reviews and other Codex subagent threads are hidden by default. F2
opts into those internal records and labels them explicitly. This uses native
source filtering plus source metadata checks; a real conversation named
"Guardian review" remains visible. Filtering changes visibility only.
Codex uses paginated `thread/list` for active and archived histories, covering
native plain and compressed histories. The history-only helper uses the same
`/codex-home` path as assistant containers, with its own credential-free tmpfs.
When it finds a stale path from an older Sessions helper, it repairs only the
cached rollout path in the shared database after matching the full thread ID
in the managed transcript's filename and metadata. The repair skips missing
or mismatched transcripts and leaves native deletion to Codex. Claude reads explicit `custom-title`
metadata or an index's `customTitle`; summaries and message previews are ignored.
An unnamed row is `Untitled Session [short-id]`. Native project paths may be the
container's `/workspace` rather than the host project's original path.

Rename writes a separate `history/CLI/cx-names/UUID.json` file, with mode 0600 and
an atomic replacement per ID. These explicit CX names take precedence over native
titles and subsequent imports/messages. Codex also uses native `thread/name/set`;
Claude has no offline naming API, so CX does not edit its transcript. Shared
history makes these names visible to every account of that CLI. Equal UUIDs in
the two CLIs have independent names. No transcript filenames, ownership or chat
content are rewritten by CX. Removal uses the existing native/reference-aware
backend and never falls back to database merging.

Each supervisor holds active selection in its own process. Resume by an explicit
UUID is marked active immediately; a native new session or native picker is
identified as native/new until CX has an explicit selected UUID. CX never guesses
active identity from the newest message, which could belong to another instance.
The current CLI/account is always shown; moving the cursor changes neither.
Native account checks can reject a resume even though the shared history is visible.

Deletion confirmation identifies the name, CLI and full UUID and warns that all
accounts of that CLI share the result. The current selected session cannot be
deleted while its assistant is open. Native Codex writer/reference checks remain
in force. Claude has no corresponding offline deletion API: each managed Claude
interactive or exec/print launch creates a `history/claude/cx-live/INSTANCE.json` lease. Deletion refuses
while any Claude lease exists, even for another row, rather than guessing which
file a native client may write next. Exit all Claude instances cleanly first.
An atomic `cx-delete-lock` directory also prevents new managed Claude writers
from starting during deletion. Unmanaged/legacy clients are outside this guard;
stop them before deletion too.

A crashed/killed supervisor can leave a writer lease. On Linux/WSL hosts, session
maintenance clears a well-formed lease only when its host PID is gone and Docker
inspection confirms no active container has a writable mount overlapping that
Claude history. The deletion gate prevents new managed Claude writers during
this check. Active PIDs, malformed/symlinked leases, container inspection errors,
and unknown container states retain the markers and keep deletion blocked.

An interrupted deletion can also leave a `cx-delete-lock` gate. CX never clears
that gate automatically or retries an uncertain mutation. If recovery remains
blocked, inspect the corresponding host processes, CX/Docker instances and
maintenance processes before manually removing stale markers or a stale gate.
Menu backend containers have networking disabled and mount histories plus read-only tools,
without account homes, project files or provider credentials. Install/portable
and custom `CX_DATA_HOME` use the same paths relative to their selected data root.
Legacy `CX_CODEX_HOME` keeps native sessions and does not offer this menu.


## GitHub CLI Access

Rebuild the CX image after updating either the installed or portable edition
to add `gh`. Store a GitHub token in a private host file outside repositories
and other mounted workspace directories. Give the file mode 0600 and grant the
token only the GitHub permissions needed for your task.

```bash
CX_GH_TOKEN_FILE="$HOME/.config/cx/github-token" cx /path/to/project --agent codex --account personal
CX_GH_TOKEN_FILE="$HOME/.config/cx/github-token" cx /path/to/project --agent claude --account work
```

From either assistant container, `gh api user --jq .login` checks GitHub
authentication and prints the account name. Repository, issue and PR operations
use the token's permissions. A 401 indicates rejected credentials. A 403 or
404 can indicate that the token lacks permission or repository access.

The file is mounted read-only in assistant containers launched by that CX
invocation, including sessions opened through its Sessions menu and SSH-mode
assistants. The token is supplied to the `gh` process. CX keeps it out of
launcher arguments and profile storage. A token supplied this way disables
interactive GitHub CLI authentication commands. Treat the token file as
accessible to code running inside the assistant container and only supply it
to sessions you trust. Keep its contents out of prompts and tool output.

CX still starts without a token. If a GitHub command needs authentication,
restart CX with `CX_GH_TOKEN_FILE`. Host `GH_TOKEN` and `GITHUB_TOKEN` alone
are not forwarded by the launcher.
