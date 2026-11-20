// Installed-server startup probe. Built-ins only: a broken SDK must not prevent
// the checker itself from reporting a useful error. No execution tools are used.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const tools = ['ssh_status', 'ssh_exec', 'ssh_poll', 'ssh_cancel',
  'ssh_interactive_start', 'ssh_interactive_exec', 'ssh_interactive_close'];

export async function checkAdapter({server = '/opt/cx-mcp/server.mjs', timeoutMs = 5000,
  status = false, env = process.env} = {}) {
  try { fs.accessSync(server, fs.constants.R_OK); }
  catch (error) {
    throw new Error(`${error.code === 'ENOENT' ? 'adapter_missing' : 'adapter_permission'}: ${server}: ${error.code}`);
  }
  const childEnv = {...env};
  if (!status) delete childEnv.CX_SSH_SOCKET;
  const child = spawn(process.execPath, [server], {env: childEnv, stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = Buffer.alloc(0), buffer = '', received = 0, phase = 1, timer;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          const detail = stderr.toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
          reject(new Error(error+(detail ? '\nAdapter stderr (bounded):\n'+detail : '')));
        } else resolve();
      };
      const send = message => child.stdin.write(JSON.stringify(message)+'\n');
      // A failed loader can close stdin before stderr has drained. Diagnose it
      // on close so permission/import errors retain the useful native stderr.
      child.stdin.on('error', () => {});
      child.on('error', error => finish('adapter_load: '+error.message));
      child.stderr.on('data', data => { stderr = Buffer.concat([stderr, data]).subarray(-8192); });
      child.on('close', (code, signal) => finish(`adapter_load: server exited before startup completed (status ${code}, signal ${signal ?? 'none'}).`));
      timer = setTimeout(() => finish('adapter_timeout: initialization/tools discovery exceeded its time limit.'), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        received += Buffer.byteLength(data);
        buffer += data;
        if (received > 1024*1024) return finish('adapter_handshake: output exceeded 1 MiB.');
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0 || settled) return;
          const line = buffer.slice(0, end); buffer = buffer.slice(end+1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); }
          catch { return finish('adapter_handshake: invalid JSON-RPC output.'); }
          if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return finish('adapter_handshake: invalid JSON-RPC envelope.');
          if (message.id === undefined && typeof message.method === 'string') continue;
          if (message.id !== phase || message.error) return finish('adapter_handshake: unexpected or failed JSON-RPC response.');
          if (phase === 1) {
            if (!message.result?.serverInfo?.name || !message.result?.capabilities?.tools ||
                message.result.protocolVersion !== '2024-11-05') {
              return finish('adapter_handshake: invalid initialize response.');
            }
            phase = 2;
            send({jsonrpc: '2.0', method: 'notifications/initialized'});
            send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
          } else if (phase === 2) {
            const names = Array.isArray(message.result?.tools) ? message.result.tools.map(tool => tool?.name) : null;
            if (!Array.isArray(names) || tools.some(name => !names.includes(name))) {
              return finish('adapter_handshake: required cx_ssh tools are missing.');
            }
            if (!status) return finish();
            phase = 3;
            send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'ssh_status', arguments: {}}});
          } else {
            if (message.result?.isError || message.result?.structuredContent?.ready !== true) {
              return finish('bridge_unavailable: adapter started, but the fixture bridge status failed.');
            }
            finish();
          }
        }
      });
      send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'cx-preflight', version: '1.0.0'}}});
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGKILL');
      await closed;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    await checkAdapter({server: args.find(arg => arg !== '--status') || undefined, status: args.includes('--status')});
    console.log('cx: SSH MCP adapter startup verified.');
  } catch (error) {
    console.error('cx: SSH MCP '+error.message);
    process.exitCode = 1;
  }
}
