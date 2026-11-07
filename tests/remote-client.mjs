import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-client-'));
const endpoint = path.join(dir, 'bridge.sock');
const command = "printf 'hello world'\nfalse";
const server = net.createServer(socket => socket.once('data', data => {
  assert.deepEqual(JSON.parse(data), {op: 'exec', command});
  socket.write(JSON.stringify({type: 'output', data: Buffer.from('hello world').toString('base64')}) + '\n');
  socket.end(JSON.stringify({type: 'done', status: 17}) + '\n');
}));
try {
  await new Promise(resolve => server.listen(endpoint, resolve));
  const child = spawn(process.execPath, ['container/cx-remote', 'exec', command], {env: {...process.env, CX_SSH_SOCKET: endpoint}});
  let output = ''; child.stdout.on('data', data => output += data);
  const status = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(output, 'hello world'); assert.equal(status, 17);
  console.log('Remote client quoting, streaming, and exit status passed.');
} finally { server.close(); fs.rmSync(dir, {recursive: true, force: true}); }
