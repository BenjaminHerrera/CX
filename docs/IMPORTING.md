# Import Native Sessions

[Handbook home](README.md) · [History reference](ACCOUNTS.md#import-existing-native-sessions)

Use this when conversations were created by ordinary Codex or Claude outside
CX. Import copies conversations into shared CX history. Creating a CX account
and logging in are separate steps; credentials and provider access are not
imported.

## Preview on the Host

Stop native and CX sessions first. Use host Node 24, outside the container,
where your native CLI homes are accessible. From the CX checkout or extracted
source bundle:

```bash
node scripts/import-sessions.mjs --dry-run
```

The installed copy is also available at the default installation path:

```bash
node "$HOME/.local/share/cx/program/bin/cx-import-sessions.mjs" --dry-run
```

Use your chosen prefix instead of `~/.local` for a custom installation. No
extra npm packages, Docker or provider requests are needed for import.

| Setting | Default |
|---|---|
| Codex source | `CODEX_HOME`, otherwise `~/.codex` |
| Claude source | `CLAUDE_CONFIG_DIR`, otherwise `~/.claude` |
| Destination | `CX_DATA_HOME`, otherwise `~/.local/share/cx/data` |

Portable imports need an explicit destination: `--data-home /path/to/bundle/data`.
Native homes and the destination must not overlap.

## Copy the Conversations

Check the preview, then use the same paths without `--dry-run`:

```bash
node scripts/import-sessions.mjs
# Example: one CLI and a portable destination
node scripts/import-sessions.mjs --agent codex --codex-home /backup/.codex \
  --data-home /path/to/bundle/data
```

Originals stay in place. Copies are independent, use private permissions and
retain IDs, transcript bytes, original project paths and attribution. Codex
active/archived rollouts, compressed rollouts and matching indexes are supported.
Claude transcripts, session-local folders and matching project indexes are
copied. Settings, credentials, plugins, private caches and project memory are
excluded. Conversations stay in their original CLI.

Reopening CX exposes the shared history to accounts of that CLI. If native
project filtering hides an import, use Sessions filters, Codex `resume --all`,
or an explicit native UUID. Provider ownership checks still apply.

## Resolve a Reported Problem

| Report | Next step |
|---|---|
| Identical files already present | Safe to repeat; those copies are skipped |
| Different versions of the same conversation | Keep the existing CX version; use `--on-conflict skip` to import the rest |
| SQLite-projected/paginated history | Supported when complete backing rollouts are available; cache rows alone are not a blocker |
| Missing/truncated rollout or ancestor | Restore complete source history, or explicitly omit it with `--skip-unavailable` |
| Symlink or overlapping path | Point at an appropriate separate native home/destination; history symlinks are not followed |
| Active import lock | Confirm the earlier importer exited before removing a stale lock |

To inspect omissions before copying:

```bash
node scripts/import-sessions.mjs --skip-unavailable --dry-run
```

That flag deliberately leaves reported sessions and dependent histories out.
It is not a repair operation. SQLite databases are never copied or merged;
native resume rebuilds projections from durable rollouts. SQL-only display
settings, such as names/pins absent from indexes, are not migrated. Use `r`
in Sessions to assign a persistent CX name afterwards.

For separate source databases, set `--codex-sqlite-home DIR`. Source WAL files
are inspected through private snapshots. Keep writers stopped through the
whole operation. An interrupted publish can leave a partial import; repeat
after inspecting any leftover lock/staging directory. The
[full reference](ACCOUNTS.md#import-existing-native-sessions) describes these rules.
