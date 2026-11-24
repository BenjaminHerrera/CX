# Watch for Changes

Rebuild the CX image before using `cx-watch` from Codex, Claude, or a CX
container shell. The watcher polls in the background and writes an event only
when something changes. Use `cx-watch --help` for command options.

The default Codex instructions and Claude startup prompt explain when to use
the watcher, how to select a source, and how to preserve state across monitor
restarts. SSH launches also append the current watcher guidance when the host
retains an older configuration. Rebuild the image and start a new assistant
session to load the updated guidance. For local Codex installations that keep
an older customized `config.toml`, merge the watcher paragraph from the current
default configuration into `developer_instructions` as well.

The owner confirmed the requested integration test passed before authorizing
the CX-18 merge. See the [validation record](MAINTAINING.md#cx-18-watcher-and-session-maintenance-validation)
for automated coverage and the distinction between owner and container checks.

## Follow a Pull Request and CI

Start the following command in the harness's background monitor. It follows the
first matching PR and any other open PRs that reference the same issue with a
closing keyword. It also follows comments on the issue.

```bash
cx-watch github --repo OWNER/REPO --closes 18 --issue 18 \
  --until merged --json --max-runtime 1700
```

CI events summarize Actions workflows and jobs for each head. Check runs are
included when the token can read them. Add `--until-ci done` to end when CI
reaches its conclusion. Use `--branch BRANCH` to match a PR's head branch, or
`--pr NUMBER` to follow a known PR. Each selector is repeatable.

| GitHub data | Read permission for a fine-grained token |
|---|---|
| Repository and PR metadata | Metadata, Pull requests |
| PR reviews and inline comments | Pull requests |
| Issue and PR conversation comments | Issues or Pull requests as applicable |
| Workflow runs and jobs | Actions |
| Additional check runs | Checks, optional |

Credential lookup uses `--token-file`, then `GH_TOKEN` or `GITHUB_TOKEN`,
then a single regular file named like `*token*` directly under
`/workspace/cx-external/`. If none exists, CX uses the credential supplied via
`CX_GH_TOKEN_FILE` or falls back to `gh auth token`. Use `--token-file` to
select among multiple matching files. `--verbose` reports the source name and
HTTP status codes on stderr. GitHub uses GET requests, conditional ETags during
a running watch, and backoff for rate-limit and transient responses.

## Wait for a Remote Result

Use an alias from the host's OpenSSH configuration. Local and SSH-mode CX
sessions can watch any configured alias. The host launcher provides a private
socket for independent batch SSH polls. Host Python 3 and OpenSSH are required.
Start this command in the background monitor.

```bash
cx-watch file --host ALIAS --path /remote/project/results.json \
  --until-match '^exists ' --json --max-runtime 1700
```

To track output from a read-only command, use `cx-watch remote --host ALIAS
--cmd 'your read-only command'`. Each poll uses a separate batch SSH channel
for the requested alias and can run while the interactive shell is busy.
OpenSSH uses the host's existing configuration and can reuse the authenticated
CX connection for the current alias or the requested alias's configured control socket. Remote commands start in the remote login directory. Remote
file watches use GNU `stat`, `tail`, and `head`. Remote commands use the
server's `timeout` utility. If batch authentication requires interaction,
complete login in CX before restarting the watch.

Use `local --cmd` for a command in the local container. Use `file --path`
without a host for local file metadata. Add `--grep REGEX` to emit matching
lines added after the baseline. For file watches, `--until-match` accepts
the new text, the event name, or `exists PATH` / `missing PATH`.
Command watches compare the exit code and both output streams, and match
against at most the first 128 KiB of each stream per poll. File content reads
are bounded to 128 KiB per poll. A very long line can be split or omitted.

## Output and Restarts

The first successful poll emits one `baseline` line. For GitHub,
`--since ISO_TIMESTAMP` emits activity after the given time on that first
poll. Subsequent polls are quiet until something changes. Events include
`pr_opened`, `head`, `state`, `review`, `review_comment`, `comment`, `ci`,
`changed`, `appeared`, `disappeared`, and `line`. CI emits at most one
pending event and one final event for each observed set of workflow runs and
attempts. A rerun on the same head starts another cycle. Changed conclusions
and additional workflows also produce an updated aggregate event. A transient failure emits one
`warn` per streak, followed by `recovered` when polling succeeds again.

Text output is one UTC timestamp, source, target, event, and key/value fields
per line. JSON lines have `time`, `source`, `target`, `event`, and `data`.
Events of the same kind for one target coalesce within the 20-second default
debounce window. Grouped activity includes an item count and up to 40
details. A satisfied stop condition or max runtime emits a final `end` and
exits 0. A fatal error emits `error` and returns a nonzero status.
`--once` polls once and flushes changes immediately. `--heartbeat SECONDS`
adds optional heartbeat events.

Set the harness to restart the command before its monitor expires, typically
around 30 minutes. Use the same watch arguments and state path each time.
State defaults to `$XDG_STATE_HOME/cx-watch/` when set, the CX workspace's
persistent state directory in an ordinary container session, or
`~/.local/state/cx-watch/` outside CX. Set `--state PATH` explicitly when the
monitor needs to share a state location across sessions. Use one monitor
process per state file. Inspect or reset the saved state with:

```bash
cx-watch state show --state PATH
cx-watch state clear --state PATH
```
