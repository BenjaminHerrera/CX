#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {zstdCompressSync,zstdDecompressSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {importSessions} from '../scripts/import-sessions.mjs';
import {historyClient} from '../container/cx-codex-resume.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-import-'));
const id='01234567-89ab-cdef-0123-456789abcdef',other='11234567-89ab-cdef-0123-456789abcdef';
let serial=0,checks=0;
function fixture(){
  const base=path.join(temp,String(++serial));fs.mkdirSync(base);
  return {base,codexHome:path.join(base,'native codex'),claudeHome:path.join(base,'native claude'),dataHome:path.join(base,'CX shared data')};
}
function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;}
function codex(home,sessionId=id,{archived=false,compressed=false,text='original'}={}){
  const file=path.join(home,archived?'archived_sessions':'sessions/2026/11/15',`rollout-2026-11-15T00-00-00-${sessionId}.jsonl${compressed?'.zst':''}`);
  const record={timestamp:'2026-11-15T00:00:00Z',type:'session_meta',payload:{id:sessionId,timestamp:'2026-11-15T00:00:00Z',cwd:temp,originator:'codex_cli_rs',cli_version:'0.169.0',source:'cli',model_provider:'openai',creator_account_id:'fixture-owner'}};
  const body=JSON.stringify(record)+'\n'+JSON.stringify({timestamp:'2026-11-15T00:00:01Z',type:'event_msg',payload:{type:'user_message',message:text,images:[],local_images:[],text_elements:[]}})+'\n';
  return write(file,compressed?zstdCompressSync(body):body);
}
function claude(home,sessionId=id,project='native-project'){
  const file=write(path.join(home,'projects',project,sessionId+'.jsonl'),JSON.stringify({sessionId,type:'user',cwd:temp,message:{role:'user',content:'original'}})+'\n');
  write(path.join(home,'projects',project,sessionId,'subagents/agent-fixture.jsonl'),'subagent transcript\n');
  write(path.join(home,'projects',project,'sessions-index.json'),JSON.stringify({version:1,originalPath:temp,entries:[{sessionId,fullPath:file,summary:'fixture'}]}));
  return file;
}
function paginated(home,sessionId=id,{compressed=false,archived=false,modelProvider='openai'}={}){
  const file=codex(home,sessionId,{compressed,archived});
  const meta={timestamp:'2026-11-15T00:00:00Z',ordinal:0,type:'session_meta',payload:{id:sessionId,timestamp:'2026-11-15T00:00:00Z',cwd:temp,originator:'codex_cli_rs',cli_version:'0.169.0',source:'cli',model_provider:modelProvider,creator_account_id:'fixture-owner',history_mode:'paginated'}};
  const events=[
    {type:'task_started',turn_id:'turn-fixture',model_context_window:null},
    {type:'item_completed',thread_id:sessionId,turn_id:'turn-fixture',item:{type:'UserMessage',id:'user-fixture',content:[{type:'text',text:'CX_SOURCE_USER',text_elements:[]}]},completed_at_ms:1},
    {type:'item_completed',thread_id:sessionId,turn_id:'turn-fixture',item:{type:'AgentMessage',id:'assistant-fixture',content:[{type:'Text',text:'CX_SOURCE_REPLY'}],phase:'final_answer'},completed_at_ms:2},
    {type:'task_complete',turn_id:'turn-fixture',last_agent_message:'CX_SOURCE_REPLY'},
  ];
  const text=[meta,...events.map((payload,index)=>({timestamp:'2026-11-15T00:00:01Z',ordinal:index+1,type:'event_msg',payload}))].map(JSON.stringify).join('\n')+'\n';
  fs.writeFileSync(file,compressed?zstdCompressSync(text):text);return file;
}
function snapshot(dir){
  if(!fs.existsSync(dir))return null;
  return Object.fromEntries(fs.readdirSync(dir,{recursive:true}).sort().map(name=>{
    const file=path.join(dir,name),s=fs.lstatSync(file);
    return [name,s.isDirectory()?'directory':s.isSymbolicLink()?'symlink':createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}
async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
try{
await check('dry run plans both native histories without creating destination or changing originals',async()=>{
  const f=fixture();codex(f.codexHome);claude(f.claudeHome);
  const before=snapshot(f.base),result=await importSessions({...f,dryRun:true});
  assert.equal(result.files,3);assert.equal(result.sessions,2);assert.equal(result.indexes,1);
  assert.deepEqual(snapshot(f.base),before);assert.equal(fs.existsSync(f.dataHome),false);
});
await check('copies histories independently, excludes credentials/settings/memory and safely repeats',async()=>{
  const f=fixture(),source=codex(f.codexHome);claude(f.claudeHome);
  for(const home of [f.codexHome,f.claudeHome])for(const name of ['auth.json','.credentials.json','config.toml','settings.json','history.sqlite'])write(path.join(home,name),'private fixture');
  write(path.join(f.claudeHome,'projects/native-project/memory/MEMORY.md'),'private project memory');
  write(path.join(f.codexHome,'history.jsonl'),JSON.stringify({session_id:id,ts:1,text:'prompt'})+'\n');
  write(path.join(f.codexHome,'session_index.jsonl'),JSON.stringify({id,thread_name:'old'})+'\n'+JSON.stringify({id,thread_name:'latest'})+'\n');
  // Remove the intentionally invalid history DB fixture: actual databases are
  // validated but never copied; credentials and config remain unread.
  fs.unlinkSync(path.join(f.codexHome,'history.sqlite'));
  const beforeCodex=snapshot(f.codexHome),beforeClaude=snapshot(f.claudeHome);
  const result=await importSessions(f);assert.equal(result.files,3);
  const dest=path.join(f.dataHome,'history/codex',path.relative(f.codexHome,source));
  assert.equal(fs.readFileSync(dest,'utf8'),fs.readFileSync(source,'utf8'));assert.notEqual(fs.statSync(dest).ino,fs.statSync(source).ino);
  assert.equal(fs.statSync(dest).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(dest)).mode&0o777,0o700);
  assert.deepEqual(snapshot(f.codexHome),beforeCodex);assert.deepEqual(snapshot(f.claudeHome),beforeClaude);
  assert.equal(fs.existsSync(path.join(f.dataHome,'profiles')),false);
  assert.equal(Object.keys(snapshot(f.dataHome)).some(name=>/auth\.json|credentials|config\.toml|settings\.json|MEMORY|sqlite/.test(name)),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataHome,'history/codex/session_index.jsonl'),'utf8')).thread_name,'latest');
  const index=JSON.parse(fs.readFileSync(path.join(f.dataHome,'history/claude/projects/native-project/sessions-index.json'),'utf8'));
  assert.equal(index.entries[0].fullPath,`/cx-history/projects/native-project/${id}.jsonl`);assert.equal(index.entries[0].sessionId,id);
  const before=snapshot(f.dataHome),again=await importSessions(f);assert.equal(again.files,0);assert.equal(again.indexes,0);assert.deepEqual(snapshot(f.dataHome),before);
  fs.appendFileSync(dest,'CX continuation\n');assert.deepEqual(snapshot(f.codexHome),beforeCodex);
});
await check('different content fails before publishing anything; skip preserves the whole conflicting session',async()=>{
  const f=fixture();codex(f.codexHome);codex(f.codexHome,other);
  const target=path.join(f.dataHome,'history/codex');codex(target,id,{text:'CX continued'});
  const before=snapshot(f.dataHome);await assert.rejects(importSessions(f),/Different content/);assert.deepEqual(snapshot(f.dataHome),before);
  const result=await importSessions({...f,onConflict:'skip'});assert.deepEqual(result.conflicts,[`codex/${id}`]);assert.equal(result.files,1);
  assert.match(fs.readFileSync(path.join(target,'sessions/2026/11/15',`rollout-2026-11-15T00-00-00-${id}.jsonl`),'utf8'),/CX continued/);
});
await check('compressed transcripts import and deduplicate against plain copies without changing archive state',async()=>{
  const f=fixture(),source=codex(f.codexHome,id,{compressed:true}),target=codex(path.join(f.dataHome,'history/codex'),id,{archived:true});
  assert.equal((await importSessions(f)).files,0);assert.equal(fs.existsSync(target),true);
  assert.equal(fs.existsSync(path.join(f.dataHome,'history/codex',path.relative(f.codexHome,source))),false);
  const g=fixture(),compressed=codex(g.codexHome,id,{compressed:true,archived:true});await importSessions(g);
  assert.deepEqual(fs.readFileSync(path.join(g.dataHome,'history/codex',path.relative(g.codexHome,compressed))),fs.readFileSync(compressed));
});
await check('Claude duplicate IDs reuse the existing project and merge missing artifacts without rewriting project memory',async()=>{
  const f=fixture(),source=claude(f.claudeHome,id.toUpperCase(),'source-project');
  const targetHome=path.join(f.dataHome,'history/claude');
  write(path.join(targetHome,'projects/target-project',id.toUpperCase()+'.jsonl'),fs.readFileSync(source));
  const result=await importSessions({...f,agent:'claude'});assert.equal(result.files,1);
  assert.equal(fs.existsSync(path.join(targetHome,'projects/source-project')),false);
  const index=JSON.parse(fs.readFileSync(path.join(targetHome,'projects/target-project/sessions-index.json'),'utf8'));
  assert.equal(index.entries[0].fullPath,`/cx-history/projects/target-project/${id.toUpperCase()}.jsonl`);
  assert.equal(fs.existsSync(path.join(targetHome,'projects/target-project',id.toUpperCase(),'subagents/agent-fixture.jsonl')),true);
});
await check('refuses source symlinks, destination symlinks and canonical path overlap',async()=>{
  for(const side of ['source','target']){
    const f=fixture(),source=codex(f.codexHome),outside=write(path.join(f.base,'outside'),'private');
    if(side==='source'){fs.unlinkSync(source);fs.symlinkSync(outside,source);}
    else{fs.mkdirSync(f.dataHome);fs.symlinkSync(f.codexHome,path.join(f.dataHome,'history'));}
    const before=snapshot(f.base);await assert.rejects(importSessions(f),/symlinked/);assert.deepEqual(snapshot(f.base),before);
  }
  const f=fixture();codex(f.codexHome);await assert.rejects(importSessions({...f,dataHome:path.join(f.codexHome,'CX')}),/overlap/);
});
await check('imports legacy and paginated histories with backing rollouts without copying databases',async()=>{
  for(const mode of ['legacy','paginated']){
    const f=fixture();if(mode==='paginated')paginated(f.codexHome);else codex(f.codexHome);
    const db=new DatabaseSync(path.join(f.codexHome,'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,history_mode TEXT)');db.prepare('INSERT INTO threads VALUES(?,?)').run(id,mode);db.close();
    const before=snapshot(f.codexHome);
    await importSessions(f);
    assert.deepEqual(snapshot(f.codexHome),before);assert.equal(fs.existsSync(path.join(f.dataHome,'history/codex/state_5.sqlite')),false);
  }
});
await check('reads SQLite WAL from a private snapshot without changing native database files',async()=>{
  const f=fixture();codex(f.codexHome);
  const db=new DatabaseSync(path.join(f.codexHome,'state_5.sqlite'));
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT,history_mode TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?)').run(id,'paginated');
    const before=snapshot(f.codexHome);await importSessions(f);
    assert.deepEqual(snapshot(f.codexHome),before);
  }finally{db.close();}
});
await check('cached projections do not block complete rollouts; genuinely missing histories require explicit skipping',async()=>{
  const f=fixture();paginated(f.codexHome);claude(f.claudeHome);
  const db=new DatabaseSync(path.join(f.codexHome,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT); CREATE TABLE thread_turns(thread_id TEXT)');
  db.prepare('INSERT INTO thread_items VALUES(?)').run(id);db.prepare('INSERT INTO thread_turns VALUES(?)').run(other);db.close();
  const before=snapshot(f.base);
  await assert.rejects(importSessions({...f,dryRun:true}),/no backing rollout/);assert.deepEqual(snapshot(f.base),before);
  const result=await importSessions({...f,skipUnavailable:true});assert.equal(result.sessions,2);
  assert.deepEqual(result.unavailable,[{id:other,reason:'no backing rollout file'}]);
  assert.equal(fs.existsSync(path.join(f.dataHome,'history/claude/projects/native-project',id+'.jsonl')),true);
  const cli=spawnSync(process.execPath,[path.join(root,'scripts/import-sessions.mjs'),'--codex-home',f.codexHome,'--claude-home',f.claudeHome,'--data-home',f.dataHome,'--skip-unavailable','--dry-run'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/1 unavailable sessions skipped/);assert.ok(cli.stdout.includes(other));
  const g=fixture();codex(g.codexHome);claude(g.claudeHome,other);
  const state=new DatabaseSync(path.join(g.codexHome,'thread_history_1.sqlite'));
  state.exec('CREATE TABLE thread_items(thread_id TEXT)');state.prepare('INSERT INTO thread_items VALUES(?)').run(other);state.close();
  const target=claude(path.join(g.dataHome,'history/claude'),other);fs.appendFileSync(target,'{"type":"fixture-change"}\n');
  const unchanged=snapshot(g.dataHome);
  await assert.rejects(importSessions({...g,skipUnavailable:true}),/Different content.*claude/);assert.deepEqual(snapshot(g.dataHome),unchanged);
});
await check('projection checkpoints validate uncompressed complete bytes and reject missing cached suffixes',async()=>{
  for(const compressed of [false,true])for(const truncated of [false,true]){
    const f=fixture(),file=paginated(f.codexHome,id,{compressed});
    const bytes=compressed?zstdDecompressSync(fs.readFileSync(file)).length:fs.statSync(file).size;
    const db=new DatabaseSync(path.join(f.codexHome,'thread_history_1.sqlite'));
    db.exec('CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER)');
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?)').run(id,bytes+(truncated?1:0));db.close();
    if(truncated){await assert.rejects(importSessions(f),/shorter than/);assert.equal(fs.existsSync(f.dataHome),false);}
    else assert.equal((await importSessions(f)).files,1);
  }
});
await check('paged records without ordinals and incomplete ancestor prefixes are refused',async()=>{
  const f=fixture(),file=paginated(f.codexHome);
  const records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);delete records[2].ordinal;
  fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(importSessions(f),/missing durable ordinals/);
  const skipped=await importSessions({...f,skipUnavailable:true});assert.equal(skipped.files,0);assert.equal(skipped.unavailable.length,1);
  const g=fixture(),parent=codex(g.codexHome),child=codex(g.codexHome,other);
  const body=fs.readFileSync(child,'utf8').trim().split('\n').map(JSON.parse);
  body[0].payload.history_base={thread_id:id,end_ordinal_exclusive:1,end_byte_offset:fs.statSync(parent).size+1};
  fs.writeFileSync(child,body.map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(importSessions(g),/truncated ancestor/);assert.equal(fs.existsSync(g.dataHome),false);
  const recoverable=await importSessions({...g,skipUnavailable:true});assert.equal(recoverable.files,1);
  assert.deepEqual(recoverable.unavailable,[{id:other,reason:'truncated ancestor rollout'}]);
});
await check('metadata-only rollouts cannot replace cached conversation content',async()=>{
  const f=fixture(),file=codex(f.codexHome);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\n')[0]+'\n');
  const db=new DatabaseSync(path.join(f.codexHome,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT)');db.prepare('INSERT INTO thread_items VALUES(?)').run(id);db.close();
  await assert.rejects(importSessions(f),/no durable body records/);assert.equal(fs.existsSync(f.dataHome),false);
});
await check('current immutable rollouts must exist even when older rollouts of that thread remain',async()=>{
  const f=fixture();paginated(f.codexHome);
  const db=new DatabaseSync(path.join(f.codexHome,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,history_mode TEXT,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run(id,'paginated',`/old/home/sessions/rollout-2026-11-15T00-00-01-${id}_${other}.jsonl`);db.close();
  await assert.rejects(importSessions(f),/current rollout referenced by SQLite is missing/);assert.equal(fs.existsSync(f.dataHome),false);
});
await check('existing CX SQLite-only history is a conflict, never silently replaced by incoming rollouts',async()=>{
  const f=fixture();paginated(f.codexHome);
  const sqlite=path.join(f.dataHome,'history/codex/sqlite');fs.mkdirSync(sqlite,{recursive:true});
  const db=new DatabaseSync(path.join(sqlite,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,history_mode TEXT)');db.prepare('INSERT INTO threads VALUES(?,?)').run(id,'paginated');db.close();
  const before=snapshot(f.dataHome);await assert.rejects(importSessions(f),/Different content/);assert.deepEqual(snapshot(f.dataHome),before);
  assert.equal((await importSessions({...f,onConflict:'skip'})).files,0);assert.deepEqual(snapshot(f.dataHome),before);
});
await check('existing index names win and history rows deduplicate across JSON field order',async()=>{
  const f=fixture();codex(f.codexHome);await importSessions(f);
  const shared=path.join(f.dataHome,'history/codex');
  write(path.join(shared,'history.jsonl'),JSON.stringify({text:'same',ts:1,session_id:id})+'\n');
  write(path.join(f.codexHome,'history.jsonl'),JSON.stringify({session_id:id,ts:1,text:'same'})+'\n');
  write(path.join(shared,'session_index.jsonl'),JSON.stringify({id,thread_name:'CX name'})+'\n');
  write(path.join(f.codexHome,'session_index.jsonl'),JSON.stringify({id,thread_name:'Native name'})+'\n');
  const before=snapshot(f.dataHome);assert.equal((await importSessions(f)).indexes,0);assert.deepEqual(snapshot(f.dataHome),before);
});
await check('missing ancestor rollouts fail; conflicts propagate to dependent Codex sessions',async()=>{
  const f=fixture(),child=codex(f.codexHome,other);
  const records=fs.readFileSync(child,'utf8').trim().split('\n').map(JSON.parse);records[0].payload.history_base={thread_id:id,end_ordinal_exclusive:1,end_byte_offset:1};fs.writeFileSync(child,records.map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(importSessions(f),/missing ancestor/);assert.equal(fs.existsSync(f.dataHome),false);
  codex(f.codexHome);codex(path.join(f.dataHome,'history/codex'),id,{text:'CX changed'});
  const result=await importSessions({...f,onConflict:'skip'});assert.equal(result.files,0);assert.equal(result.conflicts.length,2);
});
await check('malformed metadata or indexes fail before destination changes',async()=>{
  for(const kind of ['metadata','codex-index','claude-index']){
    const f=fixture(),file=codex(f.codexHome);claude(f.claudeHome);
    if(kind==='metadata')fs.writeFileSync(file,'not metadata\n');
    if(kind==='codex-index')write(path.join(f.codexHome,'session_index.jsonl'),'invalid');
    if(kind==='claude-index')write(path.join(f.claudeHome,'projects/native-project/sessions-index.json'),'invalid');
    await assert.rejects(importSessions(f),/Invalid/);assert.equal(fs.existsSync(f.dataHome),false);
  }
});
await check('CLI honors explicit paths, missing sources and dry run without Docker',async()=>{
  const f=fixture();codex(f.codexHome);
  const result=spawnSync(process.execPath,[path.join(root,'scripts/import-sessions.mjs'),'--codex-home',f.codexHome,'--claude-home',f.claudeHome,'--data-home',f.dataHome,'--dry-run'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Would import 1 sessions/);assert.equal(fs.existsSync(f.dataHome),false);
});
if(process.env.CX_NATIVE_HISTORY==='1'){
await check('native Codex discovers imported sessions in an already initialized shared history',async()=>{
  const f=fixture();codex(f.codexHome);
  const home=path.join(f.base,'CX native home'),shared=path.join(f.dataHome,'history/codex');fs.mkdirSync(home);
  for(const name of ['sessions','archived_sessions','sqlite','thread-writer-locks'])fs.mkdirSync(path.join(shared,name),{recursive:true});
  for(const name of ['history.jsonl','session_index.jsonl'])write(path.join(shared,name),'');
  for(const name of ['sessions','archived_sessions','thread-writer-locks','history.jsonl','session_index.jsonl'])fs.symlinkSync(path.join(shared,name),path.join(home,name));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CX_')&&!/^(CODEX|OPENAI|CLAUDE|ANTHROPIC|AWS|GOOGLE)/.test(key))),HOME:home,CODEX_HOME:home,CODEX_SQLITE_HOME:path.join(shared,'sqlite'),HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9'};
  async function list(){
    const client=historyClient({config:[]},{binary:process.env.CX_NATIVE_CODEX||'codex',env});
    try{await client.rpc('initialize',{clientInfo:{name:'cx-import-check',version:'1.0.0'}});return await client.rpc('thread/list',{limit:100,modelProviders:[],currentAccountOnly:false});}finally{await client.close();}
  }
  assert.equal((await list()).data.length,0);await importSessions(f);
  assert.ok((await list()).data.some(row=>row.id===id));
});
await check('native Codex reconstructs paginated user and assistant history without importing SQLite',async()=>{
  for(const compressed of [false,true]){
    const f=fixture(),file=paginated(f.codexHome,id,{compressed,modelProvider:'fixture'});
    async function read(home,sqliteHome){
      const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CX_')&&!/^(CODEX|OPENAI|CLAUDE|ANTHROPIC|AWS|GOOGLE)/.test(key))),HOME:home,CODEX_HOME:home,CODEX_SQLITE_HOME:sqliteHome,CX_FIXTURE_KEY:'fixture',HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9'};
      const config=['-c','model_provider="fixture"','-c','model="fixture"','-c','model_providers.fixture={name="CX Fixture",base_url="http://127.0.0.1:9/v1",env_key="CX_FIXTURE_KEY",wire_api="responses"}'];
      const client=historyClient({config},{binary:process.env.CX_NATIVE_CODEX||'codex',env});
      try{
        await client.rpc('initialize',{clientInfo:{name:'cx-paginated-import-check',version:'1.0.0'},capabilities:{experimentalApi:true}});
        const meta=await client.rpc('thread/read',{threadId:id,includeTurns:false});assert.equal(meta.thread.historyMode,'paginated');
        await client.rpc('thread/resume',{threadId:id,model:'fixture',modelProvider:'fixture'});
        const items=await client.rpc('thread/items/list',{threadId:id,limit:100});
        const turns=await client.rpc('thread/turns/list',{threadId:id,limit:100});
        return {items,turns};
      }finally{await client.close();}
    }
    const original=await read(f.codexHome,f.codexHome);
    assert.match(JSON.stringify(original.items),/CX_SOURCE_USER/);assert.match(JSON.stringify(original.items),/CX_SOURCE_REPLY/);
    if(compressed&&fs.existsSync(file.slice(0,-4))){
      fs.writeFileSync(file,zstdCompressSync(fs.readFileSync(file.slice(0,-4))));fs.unlinkSync(file.slice(0,-4));
    }
    const originalFile=file.endsWith('.zst')&&fs.existsSync(file.slice(0,-4))?file.slice(0,-4):file;
    const before=snapshot(f.codexHome);assert.equal((await importSessions(f)).files,1);assert.deepEqual(snapshot(f.codexHome),before);
    const shared=path.join(f.dataHome,'history/codex');
    assert.equal(Object.keys(snapshot(shared)).some(name=>name.endsWith('.sqlite')),false);
    assert.deepEqual(fs.readFileSync(path.join(shared,path.relative(f.codexHome,originalFile))),fs.readFileSync(originalFile));
    const imported=await read(shared,path.join(shared,'sqlite'));
    assert.deepEqual(imported,original);
  }
});
}
else console.log('SKIP native discovery: set CX_NATIVE_HISTORY=1 to test a real Codex binary with temporary history.');
console.log(`\n${checks} history import checks passed; no provider authentication or model requests.`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
