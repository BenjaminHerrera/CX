# Getting Started

[Handbook home](README.md) · [Installation options](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)

CX runs Codex or Claude Code in Docker against a project on your computer.
Your project stays in place, edits persist, and each named account keeps its
own credentials and settings. SSH is optional.

## Before You Start

Use Linux or WSL2, a normal non-root user, and a local Docker daemon that can
access your project. Run these commands in your **host terminal**, outside CX:

```bash
docker info
python3 --version
```

Interactive sessions need Python 3.11 or newer, Bash 4+, and GNU command-line
tools. No Python packages or tmux are needed. You also need access to the
provider you choose. CX does not supply an account or subscription.

## Install from the Repository

```bash
git clone https://github.com/BenjaminHerrera/CX.git
cd CX
./install.sh
export PATH="$HOME/.local/bin:$PATH"
cx --doctor
```

The installer builds a Docker image containing both CLIs and installs CX under
`~/.local`. Add that PATH export to your Bash startup file for future terminals.
Keep the CX checkout or portable bundle outside the project you share.
For a custom prefix or portable bundle, follow [Installation](INSTALL.md).

## Choose Your First Account

An account is a CX profile name, such as `personal` or `work`. Create one profile
for the CLI you want to use; you can add the other CLI later.

| CLI | Create a subscription profile | Sign in |
|---|---|---|
| Codex | `cx accounts add --agent codex --account personal --auth subscription` | `cx --agent codex --account personal --login` |
| Claude | `cx accounts add --agent claude --account work --auth subscription` | `cx --agent claude --account work --login` |

Complete the selected provider's displayed sign-in steps yourself. Adding a
profile does not import a native CLI login. Check your selection with:

```bash
cx accounts list
cx --agent codex --account personal --auth-status
```

Use `--agent claude --account work` in the status command for the Claude example.
[Accounts and history](ACCOUNTS.md) covers API keys and additional profiles.

## Open a Project

Replace this example with an existing project directory on your host:

```bash
cx "$HOME/projects/app"
```

Choose a CLI/account in the picker. To choose it directly:

```bash
cx --agent codex --account personal "$HOME/projects/app"
# Or, after creating and signing into the Claude profile:
cx --agent claude --account work "$HOME/projects/app"
```

The session starts in `/workspace`. Your project appears at `/workspace/main`;
that is a mount of the original project, not a second checkout. A useful first
prompt is: **“Inspect main/ and explain how to run this project's tests.”**
The other workspace folders are described in [Workspaces and Environments](WORKSPACES.md).

## Return to a Conversation

Press **Ctrl-]**, release it, then **s** to open Sessions. Or start at the menu:

```bash
cx sessions select "$HOME/projects/app"
```

Choose a row with the arrow keys. `r` renames it; Enter selects it for resume.
If an assistant is already running, CX queues the selection: return to that
assistant and exit it cleanly with its native `/exit` or Ctrl-D at an empty
prompt. CX then resumes the selected conversation. [Sessions](SESSIONS.md)
explains this handoff, deletion and the complete key map.

## Choose Your Next Task

| You want to… | Guide |
|---|---|
| Copy conversations from normal Codex or Claude | [Import Native Sessions](IMPORTING.md) |
| Share extra files or install persistent tools | [Workspaces and Environments](WORKSPACES.md) |
| Work through an existing SSH alias | [SSH and Remote Files](SSH.md) |
| Use a server's `cpu` and `gpu` allocation functions | [Slurm Setup](SLURM.md) |
| Update an existing CX installation | [Upgrade and Back Up](UPGRADING.md) |
