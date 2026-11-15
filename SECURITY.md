# Security policy

## Reporting vulnerabilities

Do not post exploit details or secrets in public issues. Use GitHub's
**Security → Report a vulnerability** when private reporting is enabled on this
repository. If unavailable, open a minimal issue requesting a private contact
route, without reproduction details or sensitive output. Wait for a private
channel before sharing details. Never share credentials, even privately.

A useful private report includes the affected version, prerequisites, impact,
and a minimal reproduction with disposable data. Responses and fixes are best
effort; no response deadline is promised. Fixes target the current release;
older versions have no backport guarantee.

## Access model

Read [access boundaries](docs/ARCHITECTURE.md#access-boundaries). Writable mounts
affect original files. Persisted Codex credentials/settings are accessible in
the container. SSH commands use remote account permissions. A read-only SSHFS
mount does not restrict command writes. Terminal framing is cooperative and
does not isolate hostile remote shells.

Never publish used portable bundles, Codex home, authentication logs, or runtime
environment stores. Revoke leaked credentials with their issuer; removing a
file or Git commit is insufficient.
