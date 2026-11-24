#!/usr/bin/env node
// Opt-in checks against real CLI binaries and a loopback-only model simulator.
// No provider login, real credentials, or provider requests. No database edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mcpOnly = process.env.CX_NATIVE_MCP === '1';
const connectionOnly = process.env.CX_NATIVE_CONNECTION === '1';
if(process.env.CX_NATIVE_HISTORY!=='1' && !mcpOnly && !connectionOnly){
  console.log('SKIP native history: set CX_NATIVE_HISTORY=1 for history or CX_NATIVE_MCP=1 for SSH MCP tool use.');
  process.exit(0);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-native-'));
const shared=path.join(temp,'shared'), cwd=path.join(temp,'workspace');
fs.mkdirSync(cwd);fs.mkdirSync(shared);
const seen=[];
const statusMarker = 'CX_NATIVE_MCP_STATUS_RESULT';
function statusTool(body) {
  if (!mcpOnly || JSON.stringify(body).includes(statusMarker)) return;
  const tool = body.tools?.find(tool => tool.name === 'mcp__cx_ssh__ssh_status');
  if (tool) return tool;
  const namespace = body.tools?.find(tool => tool.name === 'mcp__cx_ssh' &&
    tool.tools?.some(entry => entry.name === 'ssh_status'));
  if (namespace) return {name:'ssh_status', namespace:namespace.name};
  throw new Error('Native CLI must advertise cx_ssh ssh_status to the fixture model');
}
const server=http.createServer((req,res)=>handleRequest(req,res).catch(error=>{
  fixtureError ??= error;
  res.destroy();
}));
let fixtureError;
async function handleRequest(req,res){
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if (connectionOnly && req.url.includes('responses') && req.headers.authorization==='Bearer rejected-fixture') {
    res.writeHead(401,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{type:'invalid_request_error',code:'invalid_api_key',message:'invalid API key rejected-fixture'}}));
    return;
  }
  if(req.url.includes('count_tokens')){res.setHeader('Content-Type','application/json');res.end('{"input_tokens":10}');return;}
  if(req.url.includes('messages')){
    seen.push({agent:'claude',key:req.headers['x-api-key'],body});
    const message={id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'CX native history fixture'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    const tool = statusTool(body);
    if (tool) {
      message.content = [{type:'tool_use', id:'toolu_status', name:tool.name, input:{}}];
      message.stop_reason = 'tool_use';
    }
    if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return;}
    res.setHeader('Content-Type','text/event-stream');
    const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    event('message_start',{message:{...message,content:[],stop_reason:null}});
    event('content_block_start',{index:0,content_block:tool ? message.content[0] : {type:'text',text:''}});
    if (!tool) event('content_block_delta',{index:0,delta:{type:'text_delta',text:message.content[0].text}});
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:5}});
    event('message_stop',{});res.end();return;
  }
  if(req.url.includes('responses')){
    seen.push({agent:'codex',key:req.headers.authorization,body});
    res.setHeader('Content-Type','text/event-stream');
    const tool = statusTool(body);
    if (tool) {
      const item = {id:'fc_status',type:'function_call',call_id:'call_status',name:tool.name,namespace:tool.namespace,arguments:'{}',status:'completed'};
      const response = {id:'resp_status',object:'response',status:'in_progress',output:[]};
      for (const data of [{type:'response.created',response},
        {type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},
        {type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:'{}'},
        {type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response:{...response,status:'completed',output:[item]}}]) {
        res.write('data: '+JSON.stringify(data)+'\n\n');
      }
      res.end();return;
    }
    const output=[{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'CX native history fixture',annotations:[]}]}];
    for(const data of [
      {type:'response.created',response:{id:'resp_fixture',object:'response',status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...output[0],status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:'msg_fixture',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:'msg_fixture',output_index:0,content_index:0,delta:output[0].content[0].text},
      {type:'response.output_item.done',output_index:0,item:output[0]},
      {type:'response.completed',response:{id:'resp_fixture',object:'response',status:'completed',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}},
    ])res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end();return;
  }
  res.setHeader('Content-Type','application/json');res.end('{}');
}
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${server.address().port}`;
const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CX_')&&!/^(CODEX|CLAUDE|ANTHROPIC|OPENAI|AWS|GOOGLE)/.test(k)));
function run(command,args,env){return new Promise((resolve,reject)=>{
  const p=spawn(command,args,{cwd,env:{...clean,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('Native CLI timed out'));},45000);
  p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.stdin.end();p.on('error',reject);
  p.on('exit',code=>{clearTimeout(timer);if(fixtureError)reject(fixtureError);else if(code!==0)reject(new Error(`Native CLI exit ${code}: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`));else resolve(stdout);});
});}
function homes(agent,links){
  const history=path.join(shared,agent);fs.mkdirSync(history,{recursive:true});
  for(const [name,directory] of links){if(directory)fs.mkdirSync(path.join(history,name));else fs.writeFileSync(path.join(history,name),'');}
  return ['a','b'].map(name=>{
    const h=path.join(temp,agent+'-'+name);fs.mkdirSync(h);
    for(const [entry] of links)fs.symlinkSync(path.join(history,entry),path.join(h,entry));return h;
  });
}
async function discoverCodex(binary,env,threadId){
  const p=spawn(binary,['app-server'],{cwd,env:{...clean,...env},stdio:['pipe','pipe','ignore']});
  let buffer='',next=0;const pending=new Map();
  p.stdout.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const message=JSON.parse(line);
      if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}
    }
  });
  const timer=setTimeout(()=>{for(const done of pending.values())done({error:'RPC timeout'});p.kill('SIGKILL');},15000);
  const rpc=(method,params)=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);p.stdin.write(JSON.stringify({id,method,params})+'\n');});
  try{
    const initialized=await rpc('initialize',{clientInfo:{name:'cx-history-check',version:'1.0.0'}});
    assert.ok(initialized.result);
    // This checks shared storage, not the subscription-scoped native picker.
    const listed=await rpc('thread/list',{limit:100,modelProviders:[],sourceKinds:['exec'],currentAccountOnly:false});
    assert.ok(listed.result?.data.some(x=>x.id===threadId),'Codex B must discover A in native history');
  }finally{clearTimeout(timer);p.kill();await new Promise(resolve=>p.once('exit',resolve));}
}
async function nativeMcp() {
  const socket = path.join(temp,'bridge.sock'), calls = [];
  const bridge = net.createServer(client => {
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      calls.push(JSON.parse(buffer.split('\n')[0]));
      client.end(JSON.stringify({type:'status', ready:true, session_id:statusMarker})+'\n');
    });
  });
  await new Promise((resolve,reject) => bridge.once('error',reject).listen(socket,resolve));
  try {
    const adapter = path.join(root,'container/mcp/server.mjs');
    const codex = process.env.CX_NATIVE_CODEX || 'codex';
    const claude = process.env.CX_NATIVE_CLAUDE || 'claude';
    const codexHome = path.join(temp,'codex'), claudeHome = path.join(temp,'claude');
    fs.mkdirSync(codexHome); fs.mkdirSync(claudeHome);
    const codexEnv = {HOME:codexHome,CODEX_HOME:codexHome,CX_FIXTURE_KEY:'fixture',CX_SSH_SOCKET:socket};
    const claudeEnv = {HOME:claudeHome,CLAUDE_CONFIG_DIR:claudeHome,ANTHROPIC_API_KEY:'fixture',
      ANTHROPIC_BASE_URL:endpoint,DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
    console.log((await run(codex,['--version'],codexEnv)).trim());
    await run(codex,['-c','model_provider="fixture"','-c',
      `model_providers.fixture={name="CX Fixture",base_url="${endpoint}/v1",env_key="CX_FIXTURE_KEY",wire_api="responses",supports_websockets=false}`,
      '-c','mcp_servers.cx_ssh.command='+JSON.stringify(process.execPath),
      '-c','mcp_servers.cx_ssh.args='+JSON.stringify([adapter]),
      '-c','mcp_servers.cx_ssh.env_vars=["CX_SSH_SOCKET"]',
      '-c','mcp_servers.cx_ssh.required=true','-m','fixture',
      'exec','--skip-git-repo-check','Check ssh_status.'],codexEnv);
    assert.deepEqual(calls,[{op:'status'}]);
    assert.ok(seen.some(request=>request.agent==='codex' && JSON.stringify(request.body).includes(statusMarker)));
    console.log('PASS Codex discovered and called cx_ssh ssh_status.');
    console.log((await run(claude,['--version'],claudeEnv)).trim());
    const mcp = JSON.stringify({mcpServers:{cx_ssh:{command:process.execPath,args:[adapter],env:{CX_SSH_SOCKET:socket}}}});
    await run(claude,['--print','--model','claude-sonnet-4-6','--tools','','--allowedTools','mcp__cx_ssh__ssh_status',
      '--strict-mcp-config','--mcp-config',mcp,'--max-turns','3','Check ssh_status.'],claudeEnv);
    assert.deepEqual(calls,[{op:'status'},{op:'status'}]);
    assert.ok(seen.some(request=>request.agent==='claude' && JSON.stringify(request.body).includes(statusMarker)));
    console.log('PASS Claude discovered and called cx_ssh ssh_status.');
  } finally {
    await new Promise(resolve=>bridge.close(resolve));
  }
}
async function nativeHistory() {
  const codex=process.env.CX_NATIVE_CODEX||'codex',claude=process.env.CX_NATIVE_CLAUDE||'claude';
  const [a,b]=homes('codex',[['sessions',true],['archived_sessions',true],['thread-writer-locks',true],['history.jsonl',false],['session_index.jsonl',false]]);
  const codexEnv=h=>({HOME:h,CODEX_HOME:h,CODEX_SQLITE_HOME:path.join(shared,'codex/sqlite'),CX_FIXTURE_KEY:h===a?'fixture-a':'fixture-b'});
  const config=['-c','model_provider="fixture"','-c',`model_providers.fixture={name="CX Fixture",base_url="${endpoint}/v1",env_key="CX_FIXTURE_KEY",wire_api="responses",supports_websockets=false}`,'-m','fixture'];
  console.log((await run(codex,['--version'],codexEnv(a))).trim());
  const first=await run(codex,[...config,'exec','--skip-git-repo-check','--json','CX_ACCOUNT_A_MARKER'],codexEnv(a));
  const id=first.split('\n').filter(Boolean).map(JSON.parse).find(x=>x.type==='thread.started').thread_id;
  await discoverCodex(codex,codexEnv(b),id);
  await run(codex,[...config,'exec','resume','--skip-git-repo-check','--json',id,'CX_ACCOUNT_B_MARKER'],codexEnv(b));
  assert.ok(seen.some(x=>x.agent==='codex'&&x.key==='Bearer fixture-b'&&JSON.stringify(x.body).includes('CX_ACCOUNT_A_MARKER')),'Codex B must resume A using B auth');
  await Promise.all([run(codex,[...config,'exec','--skip-git-repo-check','CX_CONCURRENT_A'],codexEnv(a)),run(codex,[...config,'exec','--skip-git-repo-check','CX_CONCURRENT_B'],codexEnv(b))]);
  assert.ok(fs.readdirSync(path.join(shared,'codex/sqlite')).some(x=>x.endsWith('.sqlite')));
  console.log('PASS Codex custom-provider/API-style fixture resume and concurrent distinct conversations; subscription policy is tested separately.');
  console.log((await run(process.execPath,[path.join(root,'tests/codex-account-history.mjs')],{CX_NATIVE_HISTORY:'1',CX_NATIVE_CODEX:codex})).trim());

  const [ca,cb]=homes('claude',[['projects',true]]);
  const claudeEnv=h=>({HOME:h,CLAUDE_CONFIG_DIR:h,ANTHROPIC_API_KEY:h===ca?'fixture-a':'fixture-b',ANTHROPIC_BASE_URL:endpoint,DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
  const flags=['--output-format','json','--model','claude-sonnet-4-6','--tools','','--max-turns','1'];
  console.log((await run(claude,['--version'],claudeEnv(ca))).trim());
  const nativeBin=path.join(temp,'bin');fs.mkdirSync(nativeBin);
  const executable=claude.includes('/')?path.resolve(claude):clean.PATH.split(path.delimiter).map(p=>path.join(p,claude)).find(p=>fs.existsSync(p));
  assert.ok(executable,'Claude binary is required');fs.symlinkSync(executable,path.join(nativeBin,'claude'));
  const project=path.join(cwd,'main project');fs.mkdirSync(project);fs.mkdirSync(path.join(cwd,'.claude'));
  fs.writeFileSync(path.join(project,'CLAUDE.md'),'CX_NATIVE_PROJECT_INSTRUCTION_MARKER\n');
  fs.writeFileSync(path.join(ca,'api-key'),'fixture-a');fs.writeFileSync(path.join(cb,'api-key'),'fixture-b');
  const adapterEnv=h=>({...claudeEnv(h),PATH:nativeBin+path.delimiter+clean.PATH,CX_AGENT:'claude',CX_AUTH_MODE:'api-key',CX_PROJECT_ROOT:project,CX_GUIDANCE_FILE:path.join(root,'container/cx-guidance.txt')});
  const nativeClaude=(args,home)=>run('bash',[path.join(root,'container/cx-agent'),'--cx-session','exec',...flags,...args],adapterEnv(home));
  const created=JSON.parse(await nativeClaude(['--name','CX_SHARED_CLAUDE_FIXTURE','CX_CLAUDE_A_MARKER'],ca));
  assert.ok(created.session_id);
  const resumed=JSON.parse(await nativeClaude(['--resume','CX_SHARED_CLAUDE_FIXTURE','CX_CLAUDE_B_MARKER'],cb));
  assert.equal(resumed.session_id,created.session_id);
  assert.ok(seen.some(x=>x.agent==='claude'&&x.key==='fixture-b'&&JSON.stringify(x.body).includes('CX_CLAUDE_A_MARKER')),'Claude B must resume A using B auth');
  assert.ok(seen.some(x=>x.agent==='claude'&&JSON.stringify(x.body).includes('CX_NATIVE_PROJECT_INSTRUCTION_MARKER')),'Native additional-directory project instructions must load');
  await Promise.all([nativeClaude(['CX_CONCURRENT_A'],ca),nativeClaude(['CX_CONCURRENT_B'],cb)]);
  assert.equal(fs.existsSync(path.join(cb,'.credentials.json')),false);
  console.log('PASS Claude native cross-account resume, selected auth and concurrent distinct conversations.');

  const agentsMarker='CX_NATIVE_AGENTS_INSTRUCTION_MARKER',claudeMarker='CX_NATIVE_CLAUDE_INSTRUCTION_MARKER',importMarker='CX_NATIVE_RELATIVE_IMPORT_MARKER';
  const cases=[
    {name:'agents-only',files:{'AGENTS.md':`${agentsMarker}\n@shared-rules.md\n`},agents:1,claude:0,imported:1},
    {name:'both-files',files:{'AGENTS.md':agentsMarker,'CLAUDE.md':claudeMarker},agents:1,claude:1,imported:0},
    {name:'explicit-import',files:{'AGENTS.md':agentsMarker,'CLAUDE.md':`@AGENTS.md\n${claudeMarker}`},agents:1,claude:1,imported:0},
    {name:'symlink',files:{'AGENTS.md':agentsMarker},symlink:true,agents:1,claude:0,imported:0},
    {name:'dot-claude-agents',files:{'.claude/AGENTS.md':`${agentsMarker}\n@../shared-rules.md\n`},agents:1,claude:0,imported:1},
    {name:'excluded-agents',files:{'AGENTS.md':agentsMarker,'CLAUDE.md':claudeMarker},settings:{claudeMdExcludes:['**/AGENTS.md']},agents:0,claude:1,imported:0},
    {name:'managed-only-memory',files:{'AGENTS.md':agentsMarker,'CLAUDE.md':claudeMarker},settings:{pluginConfigs:{'cc-plugin-agents-md@builtin':{options:{instructionFiles:'managed-only'}}}},agents:0,claude:0,imported:0},
  ];
  const requestFor=marker=>seen.findLast(x=>x.agent==='claude'&&JSON.stringify(x.body.messages).includes(marker));
  for(const fixture of cases){
    fs.rmSync(project,{recursive:true});fs.mkdirSync(path.join(project,'.claude'),{recursive:true});
    fs.writeFileSync(path.join(project,'shared-rules.md'),importMarker);
    for(const [file,content] of Object.entries(fixture.files))fs.writeFileSync(path.join(project,file),content);
    if(fixture.symlink)fs.symlinkSync('AGENTS.md',path.join(project,'CLAUDE.md'));
    const settings=path.join(ca,'settings.json');fs.writeFileSync(settings,JSON.stringify(fixture.settings||{}));
    const snapshot=()=>fs.readdirSync(project,{recursive:true}).sort().map(file=>{const name=path.join(project,file);return [file,fs.lstatSync(name).isSymbolicLink()?fs.readlinkSync(name):fs.statSync(name).isFile()?fs.readFileSync(name,'utf8'):null];});
    const before=snapshot(),prompt=`CX_NATIVE_CONTEXT_${fixture.name}`;
    await nativeClaude([prompt],ca);
    const body=JSON.stringify(requestFor(prompt)?.body);assert.ok(body,fixture.name+' must reach loopback endpoint');
    for(const [marker,count] of [[agentsMarker,fixture.agents],[claudeMarker,fixture.claude],[importMarker,fixture.imported]])assert.equal(body.split(marker).length-1,count,fixture.name+' instruction occurrence: '+marker);
    assert.deepEqual(snapshot(),before,'The adapter/native startup must not edit project instruction files');
    console.log('PASS Claude native startup memory: '+fixture.name);
  }
  fs.rmSync(path.join(ca,'settings.json'));
  const selectedAgentMarker='CX_NATIVE_SELECTED_AGENT_MARKER';
  const agents=JSON.stringify({reviewer:{description:'Native option parsing fixture',prompt:selectedAgentMarker}});
  await nativeClaude(['--','--agents',agents,'--agent','reviewer','CX_NATIVE_AGENT_ESCAPE'],ca);
  assert.ok(JSON.stringify(requestFor('CX_NATIVE_AGENT_ESCAPE')?.body.system).includes(selectedAgentMarker),'Escaped --agent must select the native Claude agent');
  console.log('PASS Claude native --agent interpretation through the cx escape.');
  console.log('Live provider subscription/API login, Docker mounts and interactive pickers remain separate gates.');
}
async function nativeConnection() {
  const profile = path.join(temp,'connection-profile');
  const sharedHistory = path.join(temp,'unmounted-history');
  fs.mkdirSync(profile);
  fs.mkdirSync(sharedHistory);
  fs.writeFileSync(path.join(sharedHistory,'existing.jsonl'),'existing conversation\n');
  fs.symlinkSync(sharedHistory,path.join(profile,'sessions'));
  const config = `model = "fixture"
model_provider = "fixture"
[model_providers.fixture]
name = "CX Fixture"
base_url = "${endpoint}/v1"
env_key = "CX_FIXTURE_KEY"
wire_api = "responses"
supports_websockets = false
`;
  fs.writeFileSync(path.join(profile,'config.toml'),config);
  const codexAuth = JSON.stringify({OPENAI_API_KEY:'codex-fixture'});
  fs.writeFileSync(path.join(profile,'auth.json'),codexAuth);
  fs.writeFileSync(path.join(profile,'api-key'),'claude-fixture');
  for(const [agent,key] of [['codex','Bearer codex-fixture'],['claude','claude-fixture']]) {
    for(let i=0;i<2;i++) {
      const start=seen.length;
      const output=await run('bash',[path.join(root,'container/cx-connection'),profile],{
        CX_AGENT:agent,CX_AUTH_MODE:'api-key',CX_FIXTURE_KEY:'codex-fixture',ANTHROPIC_BASE_URL:endpoint
      });
      assert.match(output,/provider request succeeded/);
      assert.equal(seen.slice(start).filter(request=>request.agent===agent&&request.key===key).length,1);
      assert.ok(!output.includes(key));
    }
  }
  await assert.rejects(run('bash',[path.join(root,'container/cx-connection'),profile],{
    CX_AGENT:'codex',CX_AUTH_MODE:'api-key',CX_FIXTURE_KEY:'rejected-fixture'
  }),error=>/credentials rejected or expired/.test(error.message)&&!error.message.includes('rejected-fixture'));
  assert.equal(fs.readFileSync(path.join(profile,'api-key'),'utf8'),'claude-fixture');
  assert.equal(fs.readFileSync(path.join(profile,'config.toml'),'utf8'),config);
  assert.equal(fs.readFileSync(path.join(profile,'auth.json'),'utf8'),codexAuth);
  assert.deepEqual(fs.readdirSync(profile).sort(),['api-key','auth.json','config.toml','sessions']);
  assert.deepEqual(fs.readdirSync(sharedHistory),['existing.jsonl']);
  assert.equal(fs.readFileSync(path.join(sharedHistory,'existing.jsonl'),'utf8'),'existing conversation\n');
  console.log('PASS repeated native provider diagnostics preserved profiles and history, including a redacted provider rejection.');
}
try {
  if (connectionOnly) await nativeConnection();
  else if (mcpOnly) await nativeMcp();
  else await nativeHistory();
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
