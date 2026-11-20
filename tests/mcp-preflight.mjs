// No Docker/provider/SSH access: probe real stdio MCP and failure fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {checkAdapter, tools} from '../container/cx-mcp-check.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-preflight-'));
let count = 0;
async function check(name, test) { await test(); console.log(`ok ${++count} - ${name}`); }
function fixture(name, code, mode = 0o600) {
  const file = path.join(root, name+'.mjs'); fs.writeFileSync(file, code, {mode}); return file;
}
const reply = (id, result) => `console.log(JSON.stringify({jsonrpc:'2.0',id:${id},result:${JSON.stringify(result)}}));`;
const initialize = {protocolVersion:'2024-11-05', serverInfo:{name:'fixture',version:'1'}, capabilities:{tools:{}}};
const listing = {tools:tools.map(name => ({name}))};
try {
  await check('real source adapter initializes and discovers tools without a bridge', async () => {
    await checkAdapter({server:path.resolve('container/mcp/server.mjs'), env:{...process.env,CX_SSH_SOCKET:'/missing/do-not-connect'}});
  });
  await check('status uses only the read-only operation against a simulated bridge', async () => {
    const socket = path.join(root, 'bridge.sock'), calls = [];
    const bridge = net.createServer(client => {
      let buffer = '';
      client.on('data', data => {
        buffer += data;
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n')[0]); calls.push(request);
        client.end(JSON.stringify({type:'status',ready:true})+'\n');
      });
    });
    try {
      await new Promise(resolve => bridge.listen(socket, resolve));
      await checkAdapter({server:path.resolve('container/mcp/server.mjs'), env:{...process.env,CX_SSH_SOCKET:socket}});
      assert.deepEqual(calls, [], 'ordinary startup preflight must not contact the bridge');
      for (const agent of ['codex', 'claude']) {
        await checkAdapter({server:path.resolve('container/mcp/server.mjs'), status:true,
          env:{...process.env,CX_AGENT:agent,CX_SSH_SOCKET:socket}});
      }
      assert.deepEqual(calls, [{op:'status'}, {op:'status'}]);
    } finally { bridge.close(); }
  });
  await check('missing server is distinct from permission and module-load failures', async () => {
    await assert.rejects(checkAdapter({server:path.join(root,'missing.mjs')}), /adapter_missing.*ENOENT/);
    if (process.getuid?.() !== 0) {
      const file = fixture('unreadable', '', 0o000);
      try { await assert.rejects(checkAdapter({server:file}), /adapter_permission.*EACCES/); }
      finally { fs.chmodSync(file, 0o600); }
    } else console.log('SKIP unreadable-file fixture under root; use Docker arbitrary-UID verification.');
    await assert.rejects(checkAdapter({server:fixture('dependency', "import './missing-dependency.mjs';")}), /adapter_load:[\s\S]*ERR_MODULE_NOT_FOUND/);
    await assert.rejects(checkAdapter({server:fixture('syntax', 'this is invalid javascript !')}), /adapter_load:[\s\S]*SyntaxError/);
  });
  await check('malformed initialization and missing tools fail the handshake', async () => {
    for (const [name, code] of [['null','console.log("null")'], ['garbage','console.log("not json")'],
      ['init',reply(1,{})], ['tools',reply(1,initialize)+reply(2,{tools:[]})]]) {
      await assert.rejects(checkAdapter({server:fixture(name,code)}), /adapter_handshake:/);
    }
  });
  await check('unresponsive adapters time out and are terminated', async () => {
    await assert.rejects(checkAdapter({server:fixture('hang', 'setInterval(()=>{},1000)'),timeoutMs:100}), /adapter_timeout:/);
  });
  await check('output and stderr diagnostics are bounded', async () => {
    await assert.rejects(checkAdapter({server:fixture('flood', 'console.log("x".repeat(2*1024*1024))')}), /output exceeded 1 MiB/);
    try {
      await checkAdapter({server:fixture('stderr', 'process.stderr.write("x".repeat(100000)+"DIAGNOSTIC END",()=>process.exit(1))')});
      assert.fail('expected a startup error');
    } catch (error) {
      assert.match(error.message,/adapter_load:/); assert.match(error.message,/DIAGNOSTIC END/);
      assert.ok(error.message.length<9000);
    }
  });
  await check('bridge failure is reported separately after successful adapter discovery', async () => {
    const code = reply(1,initialize)+reply(2,listing)+reply(3,{isError:true,structuredContent:{error:'disconnected'}});
    await assert.rejects(checkAdapter({server:fixture('disconnected',code),status:true}), /bridge_unavailable:/);
  });
  console.log(`${count} MCP preflight checks passed; image/CLI/provider validation was not performed.`);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
