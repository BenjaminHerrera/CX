# Getting help

Start with the [handbook](docs/README.md), [GitHub Wiki](https://github.com/BenjaminHerrera/CX/wiki), and
[troubleshooting](docs/TROUBLESHOOTING.md). `cx --help`, `cx --version`,
and `cx --doctor` identify options and missing prerequisites.

If needed, [open an issue](https://github.com/BenjaminHerrera/CX/issues/new/choose).
Include a minimal command, expected/actual behavior, versions, host OS, terminal,
and local/SSH mode. For SSH, state whether ordinary host `ssh` works and whether
mounting or Slurm is involved. Share relevant redacted output only. Never upload
Codex home, SSH keys, authentication codes, or portable `data/` directories.

cx handles launch, mounts, persistence, and SSH supervision. Account access,
billing, and upstream model behavior may need upstream support. Check whether
an issue reproduces outside cx when safe. Never rerun remote work with an
unknown outcome.

Support is best effort; fixes target the current release. Linux and WSL2 are
supported host environments. Site-specific SSH, MFA, FUSE, and Slurm behavior
needs on-site validation; see [verification](docs/MAINTAINING.md).
