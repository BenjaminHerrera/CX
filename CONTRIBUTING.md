# Contributing to cx

Start with the [documentation index](docs/README.md) and
[development guide](docs/DEVELOPMENT.md). Keep contributions focused on a
reproducible user problem and explain the resulting behavior.

## Issues and proposals

Search existing issues and read [troubleshooting](docs/USAGE.md#troubleshooting).
Use the bug form for failures, the feature form for proposals, or the question
form for help. Include versions and relevant environment details. Redact personal
paths, credentials, and sensitive output. Vulnerabilities follow [SECURITY.md](SECURITY.md).

Discuss substantial changes in an issue before implementing them. Small fixes
and documentation improvements can go directly to a PR. Support and review are
best effort; no response-time commitment is implied.

## Development workflow

1. Fork the repository and branch from `main`.
2. Follow [local setup](docs/DEVELOPMENT.md#local-setup).
3. Make a focused change. Preserve local-only use, both distribution editions,
   existing settings, and SSH command ownership rules.
4. Add meaningful regression coverage for behavior changes. Run relevant suites
   and report skipped or unavailable live checks.
5. Update the relevant guides. Add user-visible changes under `Unreleased` in
   the changelog; maintainers assign release versions.
6. Open a PR using the template. Explain the problem, resulting behavior,
   validation, compatibility, limitations, and related issues.

Use clear imperative commit subjects and existing Bash, Python, and Node styles.
Avoid unrelated reformatting. Never commit runtime data, credentials, generated
archives, `node_modules`, or local environments.

## Review and merge

Use draft PRs for unfinished work. Reviewers check behavior, tests, documentation,
access boundaries, and installation/package compatibility. Address feedback in
the same branch. CI must pass and a maintainer must review before merge; this
is the project process and requires repository rules to enforce it. Maintainers
choose the merge method and release timing.

Changes to SSH framing, authentication, mounts, deletion, installation, or
packaging need an explicit explanation of failure behavior. Never replay
commands with unknown outcomes or request secrets in issue reports. Live Slurm
allocations require explicit task authorization, not just a test checklist.

## Licensing and conduct

cx has no project distribution license yet. Do not assume an open-source license
or relicense code on the owner's behalf. Retain third-party notices and describe
new dependencies and their licenses in your PR. Submit only code you have
permission to share. Follow [community conduct](CODE_OF_CONDUCT.md).
