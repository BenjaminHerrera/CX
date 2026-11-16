# Slurm Setup

[Handbook home](README.md) · [SSH walkthrough](SSH.md) · [Interactive tool reference](USAGE.md#interactive-cpu-and-gpu-sessions)

CX can enter your server's `cpu` and `gpu` Bash functions and then execute
commands inside the allocated shell. It does not supply site-specific resource
requests. Keep your server's approved allocation functions and options.

## Configure Each SSH Alias

Choose a private absolute directory on storage accessible from **both login
and compute nodes**, then run on the host:

```bash
cx --setup-slurm my-cluster --shared-dir /shared/myuser/cx
```

Complete the displayed SSH authentication yourself. Setup does not allocate a
job or require Docker. It installs the managed remote startup hook, registers
the root and saves the location separately for that exact SSH alias.

| Location | Purpose |
|---|---|
| Host `~/.config/cx/slurm-servers.json` | Per-alias server roots and optional job-ID patterns |
| Remote chosen root's `interactive/` | Allocation rendezvous files |
| Remote `~/.bashrc.d/cx-interactive.sh` | Managed compute-shell readiness hook |
| Remote `~/.config/cx/slurm-roots` | Roots the shared hook checks |

Host `XDG_CONFIG_HOME` and `CX_SLURM_CONFIG` can change the registry location.
The server directory is not a container path and is not automatically mounted.
Repeat setup for each alias or to change its root. Existing managed hooks are
updated; unrecognized hooks are not overwritten.

For a site-specific allocation message, configure a regex with one numeric
capture group:

```bash
cx --setup-slurm my-cluster --shared-dir /shared/myuser/cx \
  --job-id-pattern 'Allocation #([0-9]+)'
```

## Start an Allocation from CX

```bash
cx /path/to/local/project --ssh my-cluster --remote-dir /remote/projects/app
```

Complete login and press Ctrl-] c at the remote Bash prompt. Explicitly ask
for the allocation you need, using options appropriate to your site. For example:

> Use my server's cpu function with the resource options I supplied. Wait for
> CX's interactive readiness confirmation, then report the job ID, hostname
> and working directory before running my workload.

The assistant uses `ssh_interactive_start`, polls until `interactive_ready`,
then uses `ssh_interactive_exec` for commands within that same shell. It closes
the interactive session with `ssh_interactive_close` when finished.

## Check Readiness and Location

CX requires both the observed Slurm job ID and a matching startup-hook token.
A queue message or shell prompt alone is not readiness. The job ID is fixed
after confirmation so later command output cannot redirect the session.

Readiness does **not** prove the shell is on a compute node: some `salloc`
workflows leave it on the login host. Check `hostname` and use the site's
approved `srun` or equivalent workflow when needed. The remote Bash startup
path must source the managed hook on the allocated shell too.

## Finish or Recover

Poll existing command IDs to collect output and status. Use close to leave a
ready allocation; cancellation requests Ctrl-C for queued or active work.
After manual SSH input, CX requires another matching hook marker before
automated nested commands continue.

An idle ready allocation can survive a clean assistant session switch.
Unfinished commands block that switch. The SSHFS view continues to show the
original login host/path throughout. Interruptions can leave rendezvous files;
inspect the job and scheduler state before cleaning them up. Do not replay an
uncertain workload or assume a disconnect cancelled its job.
