# CX-7 Session Menu Validation

The implementation branch starts at `origin/v2` `9178f86`. It carries the
unmerged session-removal/import prerequisite (`feb08f4`, cherry-picked as
`c9c5fa7`) so menu deletion reuses that backend. Neither integration branch nor
release version is changed. Merge still requires explicit user approval.

## Implementation and Safety Decisions

- Local and SSH interactive managed sessions use the same isolated blue Sessions
  pane. The SSH pane remains green. No runtime tmux or additional Python package
  is required; local interactive supervision now requires host Python 3.11+.
- Rows use explicit native/CX names, neutral untitled labels and secondary
  CLI/project/UTC time/UUID context. Rename sidecars are keyed by CLI and UUID,
  independent of accounts, imports, chat previews and other running instances.
- Codex discovery/naming use native `thread/list` / `thread/name/set`; native
  deletion/reference/writer checks and plain/compressed history handling remain
  in the existing app-server/removal backend. No SQLite merging is introduced.
- Enter queues resume until a clean assistant exit. CX cannot reliably infer a
  native model/tool turn's idle state, so it does not inject a quit command or
  kill an assistant to switch. A failed exit cancels the switch; remote ownership
  is checked again at handoff. Initial prompt/task arguments are never replayed.
- Idle ready allocations, bridge command IDs, remote shell/cwd and mounts remain
  with the same SSH supervisor. Busy work/authentication/manual focus gates a
  switch. Current guidance is generated again for the selected CLI/account.
- Native ownership may reject resume. Failure remains visible; Sessions can be
  reopened without automatic retry. Known UUID resumes have an active `*`; a new
  native session/picker without an exposed UUID is explicitly shown as native/new.
  CX does not guess an active ID from recently updated conversations.
- Current selected sessions cannot be deleted while their assistant is open.
  Claude deletion additionally waits for all managed Claude writers to stop,
  because Claude has no native offline writer/reference-aware deletion API.
  Conservative instance/exec leases and an atomic deletion gate coordinate managed
  writers. Stale markers require manual inspection, never automatic cleanup.

## Offline Evidence

`tests/session-menu.mjs` covers CLI/UUID collisions, native pagination, explicit
name precedence, new messages/imported titles, duplicate names, Unicode/control
characters, stale IDs, symlink refusal, native naming calls, writer leases and
deletion gates. `CX_NATIVE_HISTORY=1` also exercises actual Codex 0.169.0 listing
and naming with a disposable rollout, without provider requests.

`tests/session_menu.py` covers cursor preservation, paging, delete/cancel/empty
states, rename input and pasted shortcuts, active-marker separation, both-screen
shortcuts, saved colors/scroll/drafts, resize, busy and failed handoff, retained
allocation identity and a real local PTY keystroke/restoration test.

Validated locally: 27 account/adapter checks, 25 smoke/install/package checks,
17 removal checks including native Codex deletion, 5 menu backend checks including
native discovery/naming, 14 menu/PTY tests, 60 SSH bridge tests, 26 screen tests
including tmux, 9 Slurm tests, 8 shared-picker checks, 18 import checks, and the
remote-client/MCP suites. Shell/Node syntax and git diff --check also pass. Fixture coverage does not establish the live gates below.

## Open Live Gates

- Installed and portable Docker launch, account changes, actual provider-owned
  native resume failures and successful handoffs with both CLIs.
- Claude explicit title/resume behavior on the integrated pinned image; the
  offline menu title fixtures alone do not establish live compatibility.
- Real terminal wheel scrolling, selection, bracketed paste, resize and terminal
  restoration in Windows Terminal/WSL. PTY/rendering tests are separate evidence.
- Consenting SSH/MCP sessions and an explicitly authorized small CPU/GPU
  allocation across an assistant switch, including readiness, actual hostname,
  command polling and scheduler cleanup. No live allocation is authorized by
  this checklist and none is claimed here.
- Existing CX-2 auth refresh/API-key/second-Claude-account/terminal gates retain
  their recorded skips and limitations. No live pass is inferred from fixtures.
