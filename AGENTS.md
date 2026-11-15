# Repository guidance for coding agents

Read `CONTRIBUTING.md` and `docs/DEVELOPMENT.md` before changing this project.
Use `docs/ARCHITECTURE.md` for access boundaries and `docs/MAINTAINING.md` for
verification and release packaging.

- Keep changes focused; preserve installed and portable editions and local use
  without SSH. Do not change release versions unless requested.
- Update documentation for user-visible behavior. Add regression coverage for
  consequential behavior changes using existing suites and fixtures.
- Use standard English title case for GitHub issue and PR titles, rule/ruleset
  names, workflow/job display names, and release titles. Follow the examples
  and capitalization rules in `docs/DEVELOPMENT.md#github-titles-and-names`.
- Preserve serialized remote command ownership, manual authentication, bounded
  output, and unknown-outcome handling. Never replay uncertain commands.
- Use simulated SSH/Slurm fixtures for routine checks. Live authentication,
  remote writes, and allocations require the user's task authorization.
- Do not expose secrets or install packages into user environments without
  authorization. Never distribute runtime data or credentials.
- `scripts/package.sh` has an explicit allowlist. Add intended distribution
  files and verify both extracted editions when changing packaging.
- Report checks, skips, and limitations accurately. Offline fixtures do not
  establish live Docker, SSHFS, Windows Terminal, or scheduler compatibility.
- Do not commit, push, publish, or change GitHub settings unless the task
  authorizes those actions. Never invent licensing decisions.
