"""Built-in host agent adapters; transport and remote command ownership stay in the bridge."""
import json
import os
import tomllib
from pathlib import Path

MCP_GUIDANCE = (' Use cx_ssh MCP ssh_status first; submit remote commands with ssh_exec and poll their IDs with ssh_poll. '
                'Never replay a command after timeout or unknown outcome, including through cx-remote. '
                'Use ssh_cancel for interruption, not rollback. For explicitly authorized CPU/GPU requests use '
                'ssh_interactive_start, wait for interactive_ready, use ssh_interactive_exec and poll its ID, '
                'then ssh_interactive_close. Readiness requires the Slurm ID and startup token; verify hostname separately. '
                'Do not send input while authenticating or waiting for readiness.')

def ssh_overrides(*, agent, launcher, host, directory, interactive_root, mount_path, mount_mode, config_root, profile, mcp_enabled):
    instructions = tomllib.loads((config_root / 'config.toml').read_text()).get('developer_instructions', '')
    # Installed configurations are preserved on upgrade; current monitoring
    # guidance still needs to reach both agents without editing those files.
    guidance = Path(__file__).resolve().parents[1] / 'container' / 'cx-guidance.txt'
    watch = next((part.strip() for part in guidance.read_text().split('\n\n')
                  if part.startswith('Use cx-watch ')), '')
    if watch and watch not in instructions:
        instructions += ' ' + watch
    instructions += (' SSH mode is active. Run cx-remote status first. Use cx-remote exec with one quoted '
                     'command string for remote command execution. Without a filesystem mount use it for file reads and edits too. Local file tools see '
                     'the local workspace. The remote Bash shell preserves directory and environment state. '
                     'For authentication or interaction ask the user to press Ctrl-] r, complete it directly, '
                     'then Ctrl-] c. Never request authentication secrets in chat or command arguments. '
                     'After disconnect do not replay commands: outcomes may be unknown and shell state is lost.')
    instructions += (' Sessions start at /workspace, a container directory containing main/, cx-external/, and remote/. '
                     'The local project is /workspace/main; extra local directories are under /workspace/cx-external. '
                     'The remote directory is empty unless the session has a filesystem mount. '
                     'Read applicable project instructions under the selected project before working there.'
                     ' Individual --add-file mounts are also under /workspace/cx-external. Edit those files '
                     'in place; deleting or replacing their mountpoints by rename is unsupported.')
    instructions += ' SSH host alias: ' + json.dumps(host) + '. Initial remote directory: ' + json.dumps(directory or 'remote login directory') + '.'
    if interactive_root:
        instructions += (' The server-specific interactive tracker directory is ' +
                         json.dumps(interactive_root, ensure_ascii=False) +
                         '; it is a remote server path, not a container mount.')
    if mount_path:
        instructions += (' A live SSHFS view of that initial directory is mounted at /workspace/remote (' + mount_mode +
                         '). Use ordinary local file tools to browse/read /workspace/remote. ' +
                         ('Edits there write directly to the server. ' if mount_mode == 'rw' else
                          'The mount is read-only; use cx-remote exec for authorized remote edits. ') +
                         '/workspace/main is still the local project. Execute remote programs through cx-remote, '
                         'using server paths rather than /workspace/remote. The mount stays rooted at the initial directory '
                         'even if the shell changes directory or enters a compute allocation. If it fails after '
                         'a disconnect, restart cx to recreate it. This mount description overrides earlier '
                         'instructions that restrict local tools to the local workspace.')
    if agent == 'claude':
        if mcp_enabled:
            instructions += MCP_GUIDANCE
        return [], {'CX_SSH_INSTRUCTIONS': instructions}
    # Preserve system instructions even for installations retaining an older config.
    overrides = ['-c', 'developer_instructions=' + json.dumps(instructions, ensure_ascii=False)]
    if mcp_enabled:
        user_root = Path(os.environ.get('CX_SELECTED_PROFILE', os.environ.get('CX_CODEX_HOME', str(Path.home() / '.codex'))))
        candidates = [config_root / 'config.toml', user_root / 'config.toml']
        project = Path(launcher[1])
        candidates += [parent / '.codex/config.toml' for parent in (project, *project.parents)]
        def has_reserved_server(value):
            return isinstance(value, dict) and (
                'cx_ssh' in value.get('mcp_servers', {}) or
                any(has_reserved_server(child) for child in value.values()))
        for config in candidates:
            if config.is_file() and has_reserved_server(tomllib.loads(config.read_text())):
                raise ValueError('MCP server cx_ssh is reserved by cx; rename it in ' + str(config) + ' or use --no-ssh-mcp.')
        if any('mcp_servers.cx_ssh' in arg for arg in launcher[2:]):
            raise ValueError('MCP server cx_ssh is reserved by cx; remove the override or use --no-ssh-mcp.')
        instructions += (' Use cx_ssh MCP ssh_status first, then ssh_exec, ssh_poll, and ssh_cancel for remote work. '
                         'These MCP recommendations supersede earlier cx-remote execution recommendations. '
                         'For explicitly authorized cpu/gpu interactive allocations use ssh_interactive_start with the existing function and its arguments, '
                         'poll until interactive_ready, then use ssh_interactive_exec and poll the returned command ID; '
                         'readiness confirms the Slurm job ID, not the physical host: check hostname and use site tools to run on the intended compute node. '
                         'use ssh_interactive_close when done. Never send commands while waiting or authenticating. '
                         'Commands are tracked only for this cx session. Never replay a command after timeout or unknown outcome, '
                         'including through cx-remote. Poll its ID instead. Cancellation requests interruption, not rollback.')
        overrides = ['-c', 'developer_instructions=' + json.dumps(instructions, ensure_ascii=False),
                     '-c', 'mcp_servers.cx_ssh.command="node"',
                     '-c', 'mcp_servers.cx_ssh.args=["/opt/cx-mcp/server.mjs"]',
                     '-c', 'mcp_servers.cx_ssh.env_vars=["CX_SSH_SOCKET"]',
                     '-c', 'mcp_servers.cx_ssh.enabled=true',
                     '-c', 'mcp_servers.cx_ssh.required=true']
    return overrides, {}
