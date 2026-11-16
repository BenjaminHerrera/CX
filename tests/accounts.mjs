#!/usr/bin/env node
// Account selection, mount boundaries and adapters; no providers or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-accounts-'));
const home=path.join(temp,'host home'), data=path.join(temp,'private data'), project=path.join(temp,'project'), bin=path.join(temp,'bin'), log=path.join(temp,'calls');
for(const dir of [home,project,bin]) fs.mkdirSync(dir,{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CX_')&&!/^(CODEX|CLAUDE|ANTHROPIC|OPENAI)/.test(k)));
Object.assign(env,{HOME:home,CX_DATA_HOME:data,PATH:`${bin}:${process.env.PATH}`,CX_TEST_LOG:log,CX_TEST_LAUNCHER:path.join(root,'bin/cx'),CX_TEST_PROJECT:project});
fs.writeFileSync(path.join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.CX_TEST_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='image'&&args.includes('--format'))console.log(args.some(a=>a.includes('io.cx.ssh-agents'))?(process.env.CX_TEST_OLD_SSH_IMAGE?'1':'2'):(process.env.CX_TEST_OLD_IMAGE?'0':'1'));
if(args[0]==='run'&&process.env.CX_TEST_EXIT)process.exit(Number(process.env.CX_TEST_EXIT));
`,{mode:0o755});
const launcher=path.join(root,'bin/cx');
function run(args=[],extra={}){const r=spawnSync('bash',[launcher,...args],{cwd:project,env:{...env,...extra},encoding:'utf8'});return r;}
function ok(args=[],extra={}){const r=run(args,extra);assert.equal(r.status,0,r.stderr);return r;}
function calls(){return fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
function last(){return calls().filter(a=>a[0]==='run').at(-1);}
function clear(){fs.writeFileSync(log,'');}
function add(agent,account,auth='subscription'){ok(['accounts','add','--agent',agent,'--account',account,'--auth',auth]);}
function pair(agent,account,...args){return ['--agent',agent,project,'--account',account,...args];}
let checks=0;
function check(name,fn){fn();console.log(`ok ${++checks} - ${name}`);}
try {
check('metadata creation, listing and defaults require no Docker or login',()=>{
  add('codex','alpha');add('codex','beta','api-key');add('claude','work');add('claude','api','api-key');
  assert.match(ok(['accounts','list']).stdout,/codex\talpha\tsubscription/);
  assert.equal(calls().length,0);assert.equal(fs.existsSync(path.join(home,'.codex')),false);
  assert.notEqual(run(['accounts','add','--agent','codex','--account','alpha','--auth','subscription']).status,0);
  assert.notEqual(run(['accounts','add','--agent','codex','--account','../bad','--auth','api-key']).status,0);
  assert.equal(fs.statSync(data).mode&0o777,0o700);
  assert.equal(fs.readFileSync(path.join(data,'profiles/codex/beta/auth-mode'),'utf8'),'api-key\n');
});
check('scripts fail without selection and use an explicit automation default',()=>{
  clear();assert.notEqual(run([project,'exec','task']).status,0);assert.equal(last(),undefined);
  ok(['accounts','default','--agent','codex','--account','alpha']);
  ok([project,'exec','task']);assert.ok(last().includes('CX_ACCOUNT=alpha'));
  assert.notEqual(run(['--agent','claude',project]).status,0);
});
check('wrapper selection before/after workspace preserves native profile and -- boundary',()=>{
  clear();ok(pair('codex','beta','--profile','native','exec','task','--','--agent','custom','--account','literal'));
  const a=last();assert.deepEqual(a.slice(-10),['--profile','native','exec','--skip-git-repo-check','task','--','--agent','custom','--account','literal'].slice(-10));
  assert.ok(a.includes('CX_AUTH_MODE=api-key'));
  ok([project,'-p','--agent','claude','--account','work','native print task']);
  assert.ok(last().includes('CX_AGENT=claude'));
  ok(pair('claude','work','-c'));assert.equal(last().at(-1),'-c');
  assert.equal(run(pair('codex','beta','exec','-'),{CX_TEST_EXIT:'23'}).status,23);
});
check('only selected account and its own CLI history are mounted; refresh paths are directories',()=>{
  for(const [agent,name] of [['codex','alpha'],['codex','beta'],['claude','work']]){
    clear();ok(pair(agent,name));const a=last();const mounts=a.filter(x=>x.startsWith('type=bind,'));
    assert.ok(mounts.includes(`type=bind,src=${data}/profiles/${agent}/${name}/home,dst=/${agent==='codex'?'codex':'claude'}-home`));
    assert.ok(mounts.includes(`type=bind,src=${data}/history/${agent},dst=/cx-history`));
    assert.equal(mounts.some(x=>x===`type=bind,src=${data},dst=/cx-history`),false);
    assert.equal(mounts.filter(x=>x.includes('/profiles/')).length,1);
    assert.equal(a.some(x=>x.includes('ANTHROPIC_API_KEY')||x.includes('OPENAI_API_KEY')),false);
  }
  assert.equal(fs.readlinkSync(`${data}/profiles/codex/alpha/home/sessions`),'/cx-history/sessions');
  assert.equal(fs.readlinkSync(`${data}/profiles/codex/beta/home/session_index.jsonl`),'/cx-history/session_index.jsonl');
  assert.equal(fs.readlinkSync(`${data}/profiles/claude/work/home/projects`),'/cx-history/projects');
});
check('all account homes and native credentials are protected from workspace/add mounts',()=>{
  const other=`${data}/profiles/codex/alpha/home`;fs.writeFileSync(`${other}/auth.json`,'fixture');
  const alias=path.join(temp,'alias');fs.symlinkSync(`${other}/auth.json`,alias);
  for(const args of [pair('codex','beta','--add-file',alias),pair('codex','beta','--add-dir',other),['--agent','codex','--account','beta',data]]){
    clear();assert.notEqual(run(args).status,0);assert.equal(last(),undefined);
  }
  assert.notEqual(run(['accounts','add','--agent','codex','--account','bad','--auth','api-key'],{CX_DATA_HOME:path.join(home,'.codex')}).status,0);
});
check('auth routes only to the chosen profile; shell and old images have clear behavior',()=>{
  for(const action of ['--login','--auth-status','--logout']){
    clear();ok(['--agent','claude','--account','api',action]);
    assert.deepEqual(last().slice(-2),['--cx-auth',action==='--auth-status'?'status':action.slice(2)]);
  }
  clear();ok(['--shell']);assert.equal(last().some(x=>x.includes('/profiles/')||x.includes('/history/')),false);
  assert.match(run(pair('claude','work'),{CX_TEST_OLD_IMAGE:'1'}).stderr,/rebuild/);
  const legacy=path.join(temp,'legacy');clear();ok([project,'exec','task'],{CX_CODEX_HOME:legacy});
  assert.ok(last().includes(`type=bind,src=${legacy},dst=/codex-home`));
  assert.notEqual(run(pair('claude','work'),{CX_CODEX_HOME:legacy}).status,0);
});
check('managed data cannot be exposed through an environment store or unexpected history paths',()=>{
  clear();assert.notEqual(run(pair('codex','alpha'),{CX_ENV_HOME:data}).status,0);assert.equal(last(),undefined);
  const sessions=`${data}/profiles/codex/beta/home/sessions`;
  fs.unlinkSync(sessions);fs.mkdirSync(sessions);
  clear();assert.match(run(pair('codex','beta')).stderr,/refusing to replace/);assert.equal(last(),undefined);
  fs.rmdirSync(sessions);fs.symlinkSync('/cx-history/sessions',sessions);
});
check('fresh portable and installed editions select their managed data defaults',()=>{
  const bundle=path.join(temp,'portable');fs.mkdirSync(path.join(bundle,'bin'),{recursive:true});
  for(const name of ['cx','VERSION','bin/cx','bin/cx-accounts.sh','config'])fs.cpSync(path.join(root,name),path.join(bundle,name),{recursive:true});
  const portable=(args)=>spawnSync('bash',[path.join(bundle,'cx'),...args],{cwd:project,env:{...env,CX_DATA_HOME:''},encoding:'utf8'});
  let r=portable(['accounts','add','--agent','codex','--account','fresh','--auth','subscription']);assert.equal(r.status,0,r.stderr);
  clear();r=portable(['--agent','codex','--account','fresh',project]);assert.equal(r.status,0,r.stderr);
  assert.ok(last().includes(`type=bind,src=${bundle}/data/profiles/codex/fresh/home,dst=/codex-home`));
  assert.equal(fs.existsSync(path.join(bundle,'data/codex')),false);
  const prefix=path.join(temp,'installed');r=spawnSync('bash',[path.join(root,'install.sh'),'--no-build','--prefix',prefix],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const installed=(args)=>spawnSync('bash',[path.join(prefix,'bin/cx'),...args],{cwd:project,env:{...env,CX_DATA_HOME:''},encoding:'utf8'});
  r=installed(['accounts','add','--agent','claude','--account','fresh','--auth','subscription']);assert.equal(r.status,0,r.stderr);
  clear();r=installed(['--agent','claude','--account','fresh',project]);assert.equal(r.status,0,r.stderr);
  assert.ok(last().includes(`type=bind,src=${home}/.local/share/cx/data/profiles/claude/fresh/home,dst=/claude-home`));
  assert.equal(fs.existsSync(path.join(home,'.claude')),false);
});
check('interactive picker always appears, filters by CLI and handles cancellation',()=>{
  const runner=path.join(temp,'picker');fs.writeFileSync(runner,'#!/bin/bash\nexec "$CX_TEST_LAUNCHER" "$CX_TEST_PROJECT" ${CX_TEST_FILTER:+--agent} ${CX_TEST_FILTER:+"$CX_TEST_FILTER"}\n',{mode:0o755});
  const pty=(input,filter='')=>spawnSync('script',['-q','-e','-c','exec "$CX_TEST_PICKER"','/dev/null'],{env:{...env,CX_TEST_PICKER:runner,CX_TEST_FILTER:filter},input,encoding:'utf8',timeout:10000});
  let r=pty('1\n');assert.equal(r.status,0,r.stdout);assert.match(r.stdout,/Choose CLI\/account/);assert.match(r.stdout,/claude\/work/);
  r=pty('q\n','claude');assert.notEqual(r.status,0);assert.match(r.stdout,/cancelled/);assert.doesNotMatch(r.stdout,/codex\/alpha/);
});

// Fake native CLIs exercise the adapter itself, including stdout/status and
// atomic replacement/logout in two concurrently usable private directories.
const fake=`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
const parsed=require('node:util').parseArgs({args:a,options:{agent:{type:'string'}},strict:false,allowPositionals:true});
const agent=path.basename(process.argv[1]);const home=process.env[agent==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'];
if(a.includes('--help')){console.log('--system-prompt-snapshot --append-system-prompt');process.exit(0);}
const action=agent==='codex'?a[0]:a[1];
if(action==='login'&&a[1]!=='status'){fs.writeFileSync(home+'/refresh.tmp','fresh-'+path.basename(home));fs.renameSync(home+'/refresh.tmp',home+'/auth.json');}
if(action==='logout')fs.rmSync(home+'/auth.json',{force:true});
console.log(JSON.stringify({args:a,nativeAgent:parsed.values.agent??null,positionals:parsed.positionals,key:process.env.ANTHROPIC_API_KEY??null,openai:process.env.OPENAI_API_KEY??null,cwd:process.cwd()}));
if(a.includes('--print')){process.stdin.pipe(process.stdout);process.exitCode=Number(process.env.CX_TEST_EXIT??0);}
`;
for(const cli of ['codex','claude'])fs.writeFileSync(path.join(bin,cli),fake,{mode:0o755});
const ca=path.join(temp,'claude-a'),cb=path.join(temp,'claude-b');
const adapterWorkspace=path.join(temp,'adapter workspace'),adapterProject=path.join(adapterWorkspace,'main project');
for(const d of [ca,cb,path.join(adapterWorkspace,'.claude'),path.join(adapterProject,'.claude')])fs.mkdirSync(d,{recursive:true});
const adapterEnv={...env,CLAUDE_CONFIG_DIR:ca,CODEX_HOME:ca,CX_AGENT:'claude',CX_PROJECT_ROOT:adapterProject,CX_GUIDANCE_FILE:path.join(root,'container/cx-guidance.txt'),ANTHROPIC_API_KEY:'unrelated-fixture',OPENAI_API_KEY:'unrelated-fixture'};
const adapter=(args,extra={},input)=>spawnSync('bash',[path.join(root,'container/cx-agent'),...args],{cwd:adapterWorkspace,env:{...adapterEnv,...extra},input,encoding:'utf8'});
check('selected-account refresh/logout never overwrites another account',()=>{
  fs.writeFileSync(cb+'/auth.json','untouched');
  assert.equal(adapter(['--cx-auth','login']).status,0);
  assert.equal(fs.readFileSync(cb+'/auth.json','utf8'),'untouched');
  assert.equal(adapter(['--cx-auth','logout']).status,0);
  assert.equal(fs.existsSync(ca+'/auth.json'),false);assert.equal(fs.readFileSync(cb+'/auth.json','utf8'),'untouched');
});
check('Claude exec translates print mode, forwards resume, streams stdin and returns native status',()=>{
  let r=adapter(['--cx-session','exec','-','--resume','fixture-id','--output-format','text'],{CX_TEST_EXIT:'19'},'piped task');
  assert.equal(r.status,19,r.stderr);assert.match(r.stdout,/piped task/);
  const d=JSON.parse(r.stdout.split('\n')[0]);assert.ok(d.args.includes('--print'));assert.ok(d.args.includes('fixture-id'));
  assert.equal(d.args[d.args.indexOf('--system-prompt-snapshot')+1],'off');assert.equal(d.key,null);assert.equal(d.openai,null);
  r=adapter(['--cx-session','--model','exec','literal']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).args.includes('--print'),false);
  r=adapter(['--cx-session','--','exec']);assert.equal(JSON.parse(r.stdout).args.includes('--print'),false);
  r=adapter(['--cx-session','--add-dir','/other','exec','a task']);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).args.includes('--print'));
  r=adapter(['--cx-session','interactive prompt']);const a=JSON.parse(r.stdout).args;
  assert.ok(a.indexOf('--add-dir')<a.indexOf('--append-system-prompt'),'variadic added directories must end at another flag before the task');
});
check('the wrapper escape is consumed once so native options are parsed by both CLIs',()=>{
  // Run the exact payload emitted by the host launcher through the adapter.
  for(const agent of ['codex','claude']){
    for(const task of [[],['exec','a task']]){
      clear();ok(pair(agent,agent==='codex'?'alpha':'work',...task,'--','--agent','reviewer'));
      const host=last(),payload=host.slice(host.indexOf('--cx-session'));
      const r=adapter(payload,{CX_AGENT:agent});assert.equal(r.status,0,r.stderr);
      const parsed=JSON.parse(r.stdout);assert.equal(parsed.nativeAgent,'reviewer');assert.equal(parsed.args.includes('--'),false);
    }
  }
  const r=adapter(['--cx-session','--','--','--agent','literal']);assert.equal(r.status,0,r.stderr);
  const parsed=JSON.parse(r.stdout);assert.equal(parsed.nativeAgent,null);assert.ok(parsed.positionals.includes('--agent'));
});
check('AGENTS startup imports use an ephemeral memory file and never edit the project',()=>{
  const agents=path.join(adapterProject,'AGENTS.md'),claude=path.join(adapterProject,'CLAUDE.md');
  fs.writeFileSync(agents,'CX_AGENTS_FIXTURE\n');
  fs.writeFileSync(claude,'CX_CLAUDE_FIXTURE\n@AGENTS.md\n');
  const before=fs.readdirSync(adapterProject,{recursive:true});
  const r=adapter(['--cx-session','prompt']);assert.equal(r.status,0,r.stderr);
  const bridge=fs.readFileSync(path.join(adapterWorkspace,'.claude/CLAUDE.md'),'utf8');
  assert.equal(bridge,`@${agents.replaceAll(' ','\\ ')}\n`);
  assert.equal(bridge.includes('CX_AGENTS_FIXTURE'),false);
  assert.deepEqual(fs.readdirSync(adapterProject,{recursive:true}),before);
  assert.equal(fs.readFileSync(claude,'utf8'),'CX_CLAUDE_FIXTURE\n@AGENTS.md\n');
  fs.unlinkSync(agents);fs.unlinkSync(claude);
  assert.equal(adapter(['--cx-session','prompt']).status,0);
  assert.equal(fs.existsSync(path.join(adapterWorkspace,'.claude/CLAUDE.md')),false);
});
check('Claude SSH keeps its native project overlay and rejects old images',()=>{
  clear();ok(pair('claude','work'),{CX_SSH_BRIDGE_DIR:temp,CX_SSH_HOST:'fixture',CX_SSH_INSTRUCTIONS:'current context',CX_SSH_MCP:'1'});
  assert.ok(last().some(a=>a.startsWith('/workspace/.claude:')));
  assert.ok(last().includes('CX_SSH_INSTRUCTIONS=current context'));
  const failed=run(pair('claude','work'),{CX_SSH_BRIDGE_DIR:temp,CX_SSH_HOST:'fixture',CX_TEST_OLD_SSH_IMAGE:'1'});
  assert.notEqual(failed.status,0);assert.match(failed.stderr,/lacks Claude SSH support/);
});
check('API-key auth is selected privately and never supplied as native arguments',()=>{
  fs.writeFileSync(ca+'/api-key','selected-fixture');
  const r=adapter(['--cx-auth','status'],{CX_AUTH_MODE:'api-key'});assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);assert.equal(d.key,'selected-fixture');assert.equal(d.args.includes('selected-fixture'),false);
  assert.equal(adapter(['--cx-auth','logout'],{CX_AUTH_MODE:'api-key'}).status,0);assert.equal(fs.existsSync(ca+'/api-key'),false);
  assert.notEqual(adapter(['--cx-auth','login'],{CX_AUTH_MODE:'api-key'},'must-not-store').status,0);
  let routed=adapter(['--cx-auth','login'],{CX_AGENT:'codex',CX_AUTH_MODE:'api-key'},'fixture-key');
  assert.equal(routed.status,0,routed.stderr);assert.deepEqual(JSON.parse(routed.stdout).args,['login','--with-api-key']);
  routed=adapter(['--cx-auth','login'],{CX_AGENT:'codex',CX_AUTH_MODE:'subscription'});
  assert.equal(routed.status,0,routed.stderr);assert.deepEqual(JSON.parse(routed.stdout).args,['login','--device-auth']);
});
check('Claude SSH registration and current resume context are session-only',()=>{
  const context='Current SSH host: fixture-new-host. Never replay uncertain commands.';
  const r=adapter(['--cx-session','--resume','fixture'],{CX_SSH_SOCKET:'/cx-ssh/bridge.sock',CX_SSH_INSTRUCTIONS:context,CX_SSH_MCP:'1'});
  assert.equal(r.status,0,r.stderr);const args=JSON.parse(r.stdout).args;
  assert.ok(args.includes('--mcp-config'));assert.ok(args.some(a=>a.includes('cx_ssh')&&a.includes('/opt/cx-mcp/server.mjs')));
  assert.ok(args[args.indexOf('--append-system-prompt')+1].includes(context));
  const fallback=adapter(['--cx-session','prompt'],{CX_SSH_SOCKET:'/cx-ssh/bridge.sock',CX_SSH_INSTRUCTIONS:context,CX_SSH_MCP:'0'});
  assert.equal(JSON.parse(fallback.stdout).args.some(a=>a.includes('cx_ssh')),false);
});
const sshEnv={CX_SSH_SOCKET:'/cx-ssh/bridge.sock',CX_SSH_MCP:'1'};
const conflict=JSON.stringify({mcpServers:{cx_ssh:{command:'fixture'}}});
check('Claude SSH checks absolute container-visible configs and preserves other servers',()=>{
  const config=path.join(adapterProject,'custom-mcp.json');
  fs.writeFileSync(config,conflict);
  try {
    for(const args of [['--mcp-config',config],['--mcp-config='+config],['--settings',config],['--settings='+config],['--mcp-config',conflict]]){
      const r=adapter(['--cx-session',...args],sshEnv);
      assert.notEqual(r.status,0);assert.match(r.stderr,/cx_ssh is reserved/);assert.equal(r.stdout,'');
    }
    assert.equal(adapter(['--cx-session','--mcp-config',config],{...sshEnv,CX_SSH_MCP:'0'}).status,0);
    // Variadic MCP configs must inspect every file, unlike --settings.
    const r=adapter(['--cx-session','--mcp-config','{"mcpServers":{}}',config],sshEnv);
    assert.notEqual(r.status,0);assert.match(r.stderr,/reserved/);
    const other=JSON.stringify({mcpServers:{other:{command:'fixture'}}});
    fs.writeFileSync(config,other);
    const allowed=adapter(['--cx-session','--mcp-config',config,'--resume','fixture'],sshEnv);
    assert.equal(allowed.status,0,allowed.stderr);assert.ok(JSON.parse(allowed.stdout).args.includes(config));
    assert.equal(fs.readFileSync(config,'utf8'),other);
  } finally {fs.unlinkSync(config);}
});
check('Claude SSH settings takes one value and leaves exec Markdown tasks intact',()=>{
  const settings=path.join(adapterWorkspace,'settings.json'),readme=path.join(adapterWorkspace,'README.md');
  fs.writeFileSync(settings,'{}');fs.writeFileSync(readme,'# A normal Markdown task\n');
  try {
    const r=adapter(['--cx-session','--settings','settings.json','exec','README.md'],sshEnv);
    assert.equal(r.status,0,r.stderr);
    const args=JSON.parse(r.stdout).args;
    assert.deepEqual(args.slice(args.indexOf('--settings')),['--settings','settings.json','--print','README.md']);
    // Prompt text and a second -- are literal, even if they look like options.
    for(const args of [['literal prompt','--settings','README.md'],['--','--','--settings','README.md']]){
      const r=adapter(['--cx-session',...args],sshEnv);assert.equal(r.status,0,r.stderr);
    }
  } finally {fs.unlinkSync(settings);fs.unlinkSync(readme);}
});
check('Claude SSH excludes inactive projects while retaining active user and project conflicts',()=>{
  const user=path.join(ca,'.claude.json');
  try {
    fs.writeFileSync(user,JSON.stringify({projects:{'/another-project':JSON.parse(conflict)}}));
    let r=adapter(['--cx-session','prompt'],sshEnv);assert.equal(r.status,0,r.stderr);
    fs.writeFileSync(user,JSON.stringify({projects:{[adapterWorkspace]:JSON.parse(conflict)}}));
    r=adapter(['--cx-session','prompt'],sshEnv);assert.notEqual(r.status,0);assert.match(r.stderr,/reserved/);
    fs.writeFileSync(user,conflict);
    r=adapter(['--cx-session','prompt'],sshEnv);assert.notEqual(r.status,0);assert.match(r.stderr,/reserved/);
  } finally {fs.rmSync(user,{force:true});}
  const projectMcp=path.join(adapterProject,'.mcp.json');
  try {
    fs.writeFileSync(projectMcp,conflict);
    const r=adapter(['--cx-session','prompt'],sshEnv);assert.notEqual(r.status,0);assert.match(r.stderr,/reserved/);
  } finally {fs.unlinkSync(projectMcp);}
  for(const file of [path.join(ca,'settings.json'),path.join(adapterProject,'.claude/settings.json'),path.join(adapterProject,'.claude/settings.local.json')]){
    try {
      fs.writeFileSync(file,conflict);
      const r=adapter(['--cx-session','prompt'],sshEnv);assert.notEqual(r.status,0);assert.match(r.stderr,/reserved/);
    } finally {
      fs.unlinkSync(file);
      for(const name of ['settings.json','settings.local.json'])fs.rmSync(path.join(adapterWorkspace,'.claude',name),{force:true});
    }
  }
});
console.log(`\n${checks} account/adapter checks passed; no live provider authentication.`);
} finally {fs.rmSync(temp,{recursive:true,force:true});}
