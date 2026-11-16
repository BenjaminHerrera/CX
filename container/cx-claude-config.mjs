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
  // Use this installed CLI's option declarations, including aliases and
  // variadic/optional values. Do not maintain a partial list that can silently
  // skip validation when Claude adds another value-taking option.
  const options = new Map();
  for (const line of (process.env.CX_CLAUDE_HELP ?? '').split('\n')) {
    if (!/^  -\S/.test(line)) continue;
    const declaration = line.trim().split(/\s{2,}/)[0];
    const value = declaration.match(/(<[^>]+>|\[[^\]]+\])/);
    const spec = {takesValue: !!value, optional: value?.[0].startsWith('['),
      variadic: value?.[0].includes('...')};
    for (const flag of declaration.split(/[<\[]/, 1)[0].match(/--?[\w-]+/g) ?? []) options.set(flag, spec);
  }
  // Some supported options are hidden from native help. Keep explicit arities
  // for these; an unknown option fails visibly rather than bypassing the check.
  for (const flag of ['--max-turns', '--system-prompt-file', '--append-system-prompt-file']) {
    if (!options.has(flag)) options.set(flag, {takesValue: true});
  }
  if (!options.has('--settings') || !options.has('--mcp-config')) {
    throw new Error('Cannot determine Claude option arity; rebuild the image or use --no-ssh-mcp.');
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    // Native options may follow the prompt. Only -- ends option parsing.
    if (!arg.startsWith('-') || arg === '-') continue;
    const equal = arg.indexOf('=');
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    const spec = options.get(flag);
    if (!spec) throw new Error(`Cannot validate Claude option ${flag}; use its long form, rebuild the image or use --no-ssh-mcp.`);
    const isConfig = flag === '--settings' || flag === '--mcp-config';
    if (equal >= 0) {
      if (isConfig) config(arg.slice(equal + 1));
    } else if (spec.takesValue && i + 1 < args.length &&
      (!spec.optional || !args[i + 1].startsWith('-'))) {
      // Required values can themselves look like options (e.g. prompt text).
      const value = args[++i];
      if (isConfig) config(value);
    } else continue;
    if (spec.variadic) {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const value = args[++i];
        if (isConfig) config(value);
      }
    }
  }
} catch (error) {
  console.error(`cx: ${error.message}`);
  process.exitCode = 1;
}
