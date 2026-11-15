# GitHub maintenance

Use [standard English title case](DEVELOPMENT.md#github-titles-and-names) for
issue and PR titles, rule/ruleset names, workflow/job display names, and release
titles. Preserve product spelling and keep matching configuration references
consistent when renaming a display name.

## Repository files

- `.github/ISSUE_TEMPLATE/`: structured bug, feature, and question forms.
- `.github/PULL_REQUEST_TEMPLATE.md`: problem, behavior, validation, and compatibility.
- `.github/workflows/ci.yml`: offline suites on pushes to `main` and pull requests.
- Root community files: contribution, support, security, and conduct policies.

Templates take effect after merging to the default branch. CI runs without
repository secrets or live account access. It uses `pull_request`, not
`pull_request_target`, so fork code does not run with elevated repository access.
It validates fixtures and archives, not live Docker, SSHFS, MFA, or real Slurm.

## Repository settings

The following require a repository administrator. Adding files does not apply
these settings automatically:

1. Enable Issues and Actions. Set the description to a short explanation of cx
   and add relevant topics such as `codex`, `docker`, `ssh`, and `slurm`.
2. Enable private vulnerability reporting under Security when available; the
   security policy includes a fallback when the feature is unavailable.
3. After CI first runs, protect `main` with a ruleset requiring pull requests,
   resolved conversations, and the `Offline checks` status check. Require one
   approving review when another maintainer is available; avoid a rule that
   prevents a sole maintainer from maintaining the project.
4. Restrict force pushes and deletion on `main`. Keep workflow token permissions
   read-only unless a specific reviewed workflow requires more.
5. Choose merge options and optionally delete merged branches automatically.
6. Choose a project license before describing cx as open source or granting
   redistribution rights. Preserve all bundled dependency notices.

No CODEOWNERS file is assigned by default. Add one only after actual reviewers
agree to ownership and review responsibilities.

### Configure Main Protections

Manage protections directly in **Settings → Rules → Rulesets**. Publish the CI
workflow and wait for its `Offline checks` job to pass before requiring that
check. Require pull requests and block force pushes and deletion on `main`.
Approving reviews and conversation resolution are optional additional rules.

If administrators need ordinary direct pushes, separate the PR/check requirements
from the force-push/deletion rules. Allow administrator bypass only on the former
ruleset. Use names such as `Main Contribution Requirements` and `Main History
Protection`. Review existing rules before making changes; other applicable
rulesets can still block an operation.

Verify the result under **Settings → Rules → Rulesets** and at
<https://github.com/BenjaminHerrera/CX/rules>. Private vulnerability reporting is
a separate setting.

## Triage

Confirm the version, environment, reproduction, impact, and appropriate component.
Ask for minimal redacted output instead of entire credential/config directories.
Close duplicates with links and explain out-of-scope requests. Move security
reports to a private channel. Suggested labels, created manually if desired:
`bug`, `enhancement`, `question`, `documentation`, `needs-info`, `area:ssh`,
`area:slurm`, `area:container`, and `area:terminal`. Forms do not depend on labels.

Review PRs against [CONTRIBUTING.md](../CONTRIBUTING.md). Inspect changes to
permissions, authentication, cleanup, dependencies, and package contents closely.
Record live checks separately from fixture coverage. Do not publish claims of
site or terminal compatibility based only on offline tests.

## Release checklist

1. Review the diff and working tree. Confirm intended scope and license status.
2. Run relevant offline suites and applicable live checks. Document unverified
   environments and skipped checks in release notes.
3. Set `VERSION`, update the MCP package version/lockfile when applicable, move
   `Unreleased` notes into a dated release, and update current-version examples.
4. Run `./scripts/package.sh`, then `(cd dist && sha256sum -c SHA256SUMS)`.
   Verify both extracted editions and their `MANIFEST.sha256` files. The smoke
   suite exercises packaging and extracted editions as well.
5. Review archive contents: retain documentation/notices, exclude credentials,
   environments, caches, `node_modules`, and used portable `data/`.
6. Review and merge the release PR. When authorized, tag the reviewed commit
   as `vX.Y.Z` and create a GitHub release with the two source archives and
   `SHA256SUMS`. Do not imply that checksums authenticate the publisher.
7. Include upgrade/image rebuild instructions and known limitations. Source
   archives contain no prebuilt Docker image. Verify the published links/files.

Publishing and tagging are manual; CI does not deploy, request model access,
change GitHub settings, or allocate remote resources.
