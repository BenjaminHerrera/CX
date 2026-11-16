# Sessions

[Handbook home](README.md) · [Account setup](GETTING-STARTED.md#choose-your-first-account) · [History reference](ACCOUNTS.md)

An **account** holds one CLI's credentials and settings. A **session** is a
conversation. Codex profiles share Codex history; Claude profiles share Claude
history. A Codex conversation remains a Codex conversation when resumed with
another account. CX does not convert conversations between CLIs or override
provider ownership restrictions.

## Open the Menu

Inside an interactive managed CX session, press **Ctrl-]**, release it, then
**s**. This works in local and SSH mode. From your host terminal:

```bash
cx sessions select /path/to/project
cx sessions select /path/to/project --agent claude --account work
```

Managed bare `resume` and `--resume` also open Sessions. Explicit session IDs
retain native CLI resume behavior. The menu requires host Python 3.11+ and an
interactive terminal; it is not enabled in redirected tasks or legacy
`CX_CODEX_HOME` mode.

## Find and Manage a Conversation

The blue Sessions screen shows the current account, persistent session names,
project context and IDs. Names do not change to the newest chat message.
Unnamed sessions have a neutral `Untitled Session [short-id]` label. Equal
names remain separate conversations; check their CLI and ID.

| Key | Action |
|---|---|
| Up / Down, Page Up / Page Down, mouse wheel | Move the highlighted row |
| `/` | Search names, projects, CLIs or IDs; chat text is not searched |
| Tab, then Left / Right | Change CLI, active/archived status or sort control |
| Ctrl-O | Toggle comfortable/dense rows |
| F2 | Show/hide internal Codex reviewer/subagent threads |
| Enter | Choose the highlighted conversation for native resume |
| `r` | Rename; Ctrl-U clears, Enter saves, Esc cancels |
| `d` or Delete | Request deletion; `y` confirms, `n` or Esc cancels |
| `f` | Refresh the list |
| Esc or `q` | Close the menu |

While editing a search, letters go into the search field. Enter resumes the
highlighted result, Esc leaves search editing, and Ctrl-U clears the query.
Active/non-archived sessions are shown initially, sorted by name in compact rows.
CLI and last-updated metadata occupy a separate right-aligned area; narrow
terminals stack that area below the name. Change the status control
to find archived sessions. F2 changes visibility only; it does not delete
internal threads or filter by their names.

The cursor marks the candidate row. A separate `*` marks a **known active
conversation in this CX instance**. A new native session can be labeled
native/new until CX has an explicit UUID; CX does not guess from recent messages.

## Switch Without Losing Your Current Draft

1. Open Sessions, highlight a conversation and press Enter.
2. CX keeps the current assistant running in a saved background session and
   immediately resumes the selected conversation, or restores its existing PTY.
3. Select a `[running]` row to return to its process, screen and unsent draft.

No manual `/exit` or Ctrl-D is required. Switching does not submit text or
interrupt the old assistant. Background assistants can continue their work;
only the selected assistant receives your keyboard input. Esc/`q` returns to
the prior assistant; after a failed resume it restores the saved assistant.
When switching CLIs, choose an existing compatible account in the menu.

An assistant whose native ID is unknown appears as `Running Codex session` or
`Running Claude session` when saved. This is a temporary PTY identity within
this CX instance, not a guessed native conversation ID. Use that row to return;
it cannot be renamed or deleted through the history helper. CX does not equate
it with a newly discovered native history row. Avoid opening the same
conversation again as a separate native resume.

In SSH mode, return to assistant focus with **Ctrl-] c** before switching.
Authentication, manual SSH focus and unfinished remote commands block switching
with an explanation. An idle ready allocation and the existing SSH connection
stay in place. Remote ownership is checked again at handoff; uncertain work is
never replayed. All assistants share the same serialized bridge, and background
output continues to update its own saved screen. A restored process retains its
existing context; a new resume receives current workspace and SSH guidance.

Saved processes live only until this CX instance ends. **Ctrl-] q** explicitly
exits CX, including from the menu, and stops all its assistants. To finish one
assistant, return to it and exit using its native controls. If others remain,
CX opens Sessions so you can select one. Running conversations cannot be deleted
from the menu, and saved Claude writers retain their history leases.

## Rename or Delete

CX names persist across restarts, later messages and imports, and are shared
by accounts of the same CLI. Renaming does not change a transcript's ID,
ownership or contents. [Naming details](ACCOUNTS.md#session-names-and-menu-safety)
describe the native metadata and CX name records.

Deletion is permanent for every account sharing that CLI's history. Read the
name, CLI and full UUID in the confirmation. A running active conversation
cannot be deleted. Claude deletion waits for all managed Claude writers to
stop; Codex retains native writer and history-reference checks.

For removal by a known full UUID, close relevant sessions and run on the host:

```bash
cx sessions remove SESSION_ID
cx sessions remove SESSION_ID --agent claude
```

Use `--agent` if the same UUID exists under both CLIs. Profile removal is a
different operation: `cx accounts remove NAME` removes that profile while
preserving shared conversations. See [account removal](ACCOUNTS.md#remove-an-account)
and [session removal](ACCOUNTS.md#remove-a-session) for failure and recovery rules.
