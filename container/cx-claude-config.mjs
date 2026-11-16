// Run inside the session container so paths, masks and profile mounts match
// Claude's actual view. This checker never writes native configuration.
import fs from 'node:fs';
import path from 'node:path';

const reserved = value => value?.mcpServers && Object.hasOwn(value.mcpServers, 'cx_ssh');
function check(value, source) {
  if (reserved(value)) throw new Error(`MCP server cx_ssh is reserved by cx; rename it in ${source} or use --no-ssh-mcp.`);
}
function read(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Cannot read Claude configuration ${file} as JSON.`); }
}
function config(value) {
  if (value.trimStart().startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new Error('Cannot read inline Claude configuration as JSON.'); }
    check(parsed, 'inline configuration');
  } else {
    // Relative native CLI paths resolve from the process working directory.
    const file = path.resolve(value);
    check(read(file), file);
  }
}

try {
  const profile = process.env.CLAUDE_CONFIG_DIR;
  const project = process.env.CX_PROJECT_ROOT ?? '/workspace/main';
  const userFile = path.join(profile, '.claude.json');
  const user = read(userFile);
  check(user, userFile);
  // Native local-scope MCP configuration belongs to the current working
  // directory, not every project ever visited by this account.
  check(user.projects?.[process.cwd()], `${userFile} (current project)`);
  for (const file of [path.join(profile, 'settings.json'), path.join(project, '.mcp.json'),
    path.join(process.cwd(), '.mcp.json'), path.join(process.cwd(), '.claude/settings.json'),
    path.join(process.cwd(), '.claude/settings.local.json')]) check(read(file), file);

  const args = process.argv.slice(2);
  // Skip values for other native options so prompt text resembling an option
  // cannot accidentally become a configuration source. A positional ends options.
  const single = new Set(['--model', '--append-system-prompt', '--system-prompt', '--agent',
    '--resume', '-r', '--output-format', '--input-format', '--max-turns', '--max-budget-usd',
    '--effort', '--permission-mode', '--setting-sources', '--system-prompt-snapshot',
    '--system-prompt-file', '--append-system-prompt-file', '--session-id', '--plugin-dir',
    '--fallback-model', '--json-schema']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' || !arg.startsWith('-')) break;
    if (arg.startsWith('--settings=') || arg.startsWith('--mcp-config=')) {
      config(arg.slice(arg.indexOf('=') + 1));
    } else if (arg === '--settings') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) config(args[++i]);
    } else if (arg === '--mcp-config' || arg === '--add-dir') {
      // These native options are variadic; --settings takes exactly one value.
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const value = args[++i];
        if (arg === '--mcp-config') config(value);
      }
    } else if (single.has(arg) && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
  }
} catch (error) {
  console.error(`cx: ${error.message}`);
  process.exitCode = 1;
}
