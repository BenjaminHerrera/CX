import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '../container/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../container/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-mcp-'));
const socketPath=path.join(dir,'bridge.sock');
const calls=[];
const server=net.createServer(socket=>{
  let buffer='';
  socket.on('data',data=>{
    buffer+=data;
    if (!buffer.includes('\n')) return;
    const request=JSON.parse(buffer.split('\n')[0]); calls.push(request);
    const result=request.op==='status' ? {type:'status',ready:true,session_id:'session',active_command_id:null} :
      {type:'job',command_id:request.command_id,state:request.op==='cancel'?'interrupt_requested':'running',data:Buffer.from('hello').toString('base64'),next_cursor:5};
    socket.end(JSON.stringify(result)+'\n');
  });
});
let client;
try {
  await new Promise(resolve=>server.listen(socketPath,resolve));
  client=new Client({name:'cx-tests',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['container/mcp/server.mjs'],env:{...process.env,CX_SSH_SOCKET:socketPath}}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['ssh_status','ssh_exec','ssh_poll','ssh_cancel','ssh_interactive_start','ssh_interactive_exec','ssh_interactive_close']);
  assert.equal((await client.callTool({name:'ssh_status',arguments:{}})).structuredContent.ready,true);
  const started=await client.callTool({name:'ssh_exec',arguments:{command:"printf 'hello'"}});
  const id=started.structuredContent.command_id;
  assert.match(id,/^[0-9a-f-]{36}$/);
  assert.equal(started.structuredContent.output,'hello');
  await client.callTool({name:'ssh_poll',arguments:{command_id:id,cursor:5}});
  assert.equal(calls.at(-1).cursor,5);
  assert.equal((await client.callTool({name:'ssh_cancel',arguments:{command_id:id}})).structuredContent.state,'interrupt_requested');
  const session=await client.callTool({name:'ssh_interactive_start',arguments:{command:'cpu 4'}});
  const sessionId=session.structuredContent.command_id;
  await client.callTool({name:'ssh_interactive_exec',arguments:{session_command_id:sessionId,command:'hostname'}});
  assert.equal(calls.at(-1).session_command_id,sessionId);
  assert.equal(calls.at(-1).op,'interactive_exec');
  await client.callTool({name:'ssh_interactive_close',arguments:{command_id:sessionId}});
  assert.equal(calls.at(-1).op,'interactive_close');
  const count=calls.length;
  assert.equal((await client.callTool({name:'ssh_poll',arguments:{command_id:'bad'}})).isError,true);
  assert.equal(calls.length,count);
  await client.close();
  client=new Client({name:'cx-tests-restart',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['container/mcp/server.mjs'],env:{...process.env,CX_SSH_SOCKET:socketPath}}));
  await client.callTool({name:'ssh_poll',arguments:{command_id:id}});
  assert.equal(calls.filter(c=>c.op==='submit').length,1);
  console.log('MCP discovery, validation, structured results, routing, and restart checks passed.');
} finally {
  if(client) await client.close();
  server.close(); fs.rmSync(dir,{recursive:true,force:true});
}
