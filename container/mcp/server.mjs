import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name:'cx-ssh', version:'1.2.1'});
function request(message) {
  return new Promise((resolve, reject) => {
    if (!process.env.CX_SSH_SOCKET) return reject(new Error('No cx SSH socket configured.'));
    const socket = net.createConnection(process.env.CX_SSH_SOCKET);
    let buffer = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => finish(new Error('Bridge response timed out; command outcome may be unknown. Do not replay.')));
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Bridge closed; do not replay commands automatically.')));
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('Bridge response too large.'));
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        try { finish(null, JSON.parse(buffer.slice(0,end))); }
        catch { finish(new Error('Invalid bridge response.')); }
      }
    });
  });
}
function register(name, description, inputSchema, operation) {
  server.registerTool(name, {description, inputSchema,
    annotations:{readOnlyHint:['ssh_status','ssh_poll'].includes(name),
                 destructiveHint:!['ssh_status','ssh_poll'].includes(name),openWorldHint:true}}, async args => {
    const message = operation(args);
    try {
      const result = await request(message);
      if (result.data !== undefined) {
        result.output_base64 = result.data;
        result.output = Buffer.from(result.data, 'base64').toString('utf8');
        delete result.data;
      }
      return {content:[{type:'text',text:JSON.stringify(result)}], structuredContent:result,
              isError:Boolean(result.error || result.exit_code)};
    } catch (error) {
      const result = {error:error.message, code:'transport_error', command_id:message.command_id ?? null};
      return {content:[{type:'text',text:JSON.stringify(result)}], structuredContent:result,isError:true};
    }
  });
}
register('ssh_status','Inspect SSH readiness, manual terminal focus, mount, and active command ID.',{},()=>({op:'status'}));
register('ssh_exec','Start one tracked command in the persistent remote Bash shell. Poll its ID; never replay after a timeout. Directory and environment changes persist.',
  {command:z.string().min(1).max(1024*1024)},args=>({op:'submit',command:args.command,command_id:randomUUID()}));
register('ssh_poll','Read up to 64 KiB of combined PTY output and command state. Pass next_cursor to retrieve more. Records last only for this cx session.',
  {command_id:z.string().uuid(),cursor:z.number().int().nonnegative().optional()},args=>({op:'poll',...args}));
register('ssh_cancel','Request Ctrl-C for a tracked command once. Interruption is not rollback; completion may remain unknown. Use manual SSH recovery if needed.',
  {command_id:z.string().uuid()},args=>({op:'cancel',...args}));
register('ssh_interactive_start','Start an explicitly authorized cpu or gpu function with its usual arguments. Poll the returned ID until interactive_ready is true. Never replay after a timeout. The remote startup hook and shared rendezvous directory are required.',
  {command:z.string().min(1).max(4096)},args=>({op:'interactive_start',command:args.command,command_id:randomUUID()}));
register('ssh_interactive_exec','Start one command in a confirmed ready interactive Slurm allocation shell. Check hostname and use site tools to ensure work runs on the intended compute node. Poll the command ID for output and status. Shell state persists.',
  {session_command_id:z.string().uuid(),command:z.string().min(1).max(1024*1024)},args=>({op:'interactive_exec',...args,command_id:randomUUID()}));
register('ssh_interactive_close','Exit an idle interactive compute shell and return to the login shell. Poll the session ID for completion.',
  {command_id:z.string().uuid()},args=>({op:'interactive_close',...args}));
await server.connect(new StdioServerTransport());
