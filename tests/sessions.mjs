#!/usr/bin/env node
// Session deletion in disposable histories; providers and real user data unused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {removeSession} from '../container/cx-sessions.mjs';
import {historyClient} from '../container/cx-codex-resume.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-sessions-'));
const id='01234567-89ab-cdef-0123-456789abcdef',other='11234567-89ab-cdef-0123-456789abcdef';
let count=0,serial=0;
function fixture(){
  const base=path.join(temp,String(++serial));fs.mkdirSync(base);
  const codexRoot=path.join(base,'codex'),claudeRoot=path.join(base,'claude');
  for(const name of ['sessions/2026/11/15','archived_sessions','sqlite','thread-writer-locks'])fs.mkdirSync(path.join(codexRoot,name),{recursive:true});
  for(const name of ['session_index.jsonl','history.jsonl'])fs.writeFileSync(path.join(codexRoot,name),'');
  fs.mkdirSync(path.join(claudeRoot,'projects'),{recursive:true});
  return {base,codexRoot,claudeRoot,codexHome:path.join(base,'temporary home')};
}
function transcript(f,sessionId=id,archived=false){
  const dir=path.join(f.codexRoot,archived?'archived_sessions':'sessions/2026/11/15');
  const file=path.join(dir,`rollout-2026-11-15T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file,JSON.stringify({timestamp:'2026-11-15T00:00:00Z',type:'session_meta',payload:{id:sessionId,timestamp:'2026-11-15T00:00:00Z',cwd:f.base,originator:'codex_cli_rs',cli_version:'0.169.0',source:'cli',model_provider:'openai'}})+'\n');
  return file;
}
function claudeTranscript(f,sessionId=id,project='project with spaces'){
  const dir=path.join(f.claudeRoot,'projects',project);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,sessionId+'.jsonl');fs.writeFileSync(file,JSON.stringify({sessionId,type:'user',message:{content:'fixture'}})+'\n');return file;
}
function native(file,{failure}={}){
  const calls=[];let closed=0;
  return {calls,get closed(){return closed;},createClient:()=>({
    async rpc(method,params){
      calls.push({method,params});
      if(method==='thread/read'){
        if(!file)throw new Error(`thread not loaded: ${params.threadId}`);
        return {thread:{id:params.threadId,path:file}};
      }
      if(method==='thread/delete'&&failure)throw new Error(failure);
      if(method==='thread/delete'&&file)fs.rmSync(file);
      return {};
    },notify(){},async close(){closed++;},
  })};
}
function realNativeClient(request,{env}){
  const clean=Object.fromEntries(Object.entries(env).filter(([name])=>!/^(OPENAI|ANTHROPIC|CLAUDE|AWS|GOOGLE)|^CODEX_.*(TOKEN|KEY)/.test(name)));
  return historyClient(request,{binary:process.env.CX_NATIVE_CODEX||'codex',env:{...clean,HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9'}});
}
async function check(name,fn){await fn();console.log(`ok ${++count} - ${name}`);}
try{
await check('full UUID validation rejects missing, shortened and traversal IDs before discovery',async()=>{
  for(const value of ['',undefined,'01234567','../'+id,id+'/extra'])await assert.rejects(removeSession({id:value}),/full session UUID/);
});
await check('Codex native deletion also removes exact index/history rows and preserves other conversations',async()=>{
  const f=fixture(),file=transcript(f),kept=transcript(f,other),client=native(file);
  const keep=JSON.stringify({id:other,thread_name:'Keep this'})+'\n';
  fs.writeFileSync(path.join(f.codexRoot,'session_index.jsonl'),JSON.stringify({id,thread_name:'Remove this'})+'\n'+keep+'malformed fixture\n');
  fs.writeFileSync(path.join(f.codexRoot,'history.jsonl'),JSON.stringify({session_id:id,text:'remove'})+'\n'+JSON.stringify({session_id:other,text:id}));
  assert.equal(await removeSession({...f,id:id.toUpperCase(),createClient:client.createClient}),'codex');
  assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(kept),true);
  assert.equal(fs.readFileSync(path.join(f.codexRoot,'session_index.jsonl'),'utf8'),keep+'malformed fixture\n');
  assert.equal(fs.readFileSync(path.join(f.codexRoot,'history.jsonl'),'utf8'),JSON.stringify({session_id:other,text:id}));
  assert.deepEqual(client.calls.find(x=>x.method==='thread/delete').params,{threadId:id});assert.equal(client.closed,1);
});
await check('archived Codex transcripts use native deletion too',async()=>{
  const f=fixture(),file=transcript(f,id,true),client=native(file);
  await removeSession({...f,id,agent:'codex',createClient:client.createClient});assert.equal(fs.existsSync(file),false);
});
await check('Claude removal includes subagent transcripts and every matching project index',async()=>{
  const f=fixture(),file=claudeTranscript(f),kept=claudeTranscript(f,other),project=path.dirname(file);
  const tree=path.join(project,id,'subagents');fs.mkdirSync(tree,{recursive:true});fs.writeFileSync(path.join(tree,'agent-fixture.jsonl'),'subagent');
  const memory=path.join(project,'memory');fs.mkdirSync(memory);fs.writeFileSync(path.join(memory,'MEMORY.md'),'keep');
  for(const projectName of [path.basename(project),'another-project']){
    const dir=path.join(f.claudeRoot,'projects',projectName);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'sessions-index.json'),JSON.stringify({version:1,originalPath:'/project',entries:[{sessionId:id},{sessionId:other,summary:id}]}));
  }
  assert.equal(await removeSession({...f,codexRoot:undefined,id}),'claude');
  assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(path.join(project,id)),false);assert.equal(fs.existsSync(kept),true);
  assert.equal(fs.readFileSync(path.join(memory,'MEMORY.md'),'utf8'),'keep');
  for(const name of fs.readdirSync(path.join(f.claudeRoot,'projects'))){
    const index=JSON.parse(fs.readFileSync(path.join(f.claudeRoot,'projects',name,'sessions-index.json')));
    assert.deepEqual(index,{version:1,originalPath:'/project',entries:[{sessionId:other,summary:id}]});
  }
});
await check('cross-CLI ID collisions fail without deletion and --agent disambiguates',async()=>{
  const f=fixture(),codex=transcript(f),claude=claudeTranscript(f),client=native(codex);
  await assert.rejects(removeSession({...f,id,createClient:client.createClient}),/both CLIs/);
  assert.equal(fs.existsSync(codex),true);assert.equal(fs.existsSync(claude),true);
  assert.equal(client.calls.some(x=>x.method==='thread/delete'),false);assert.equal(client.closed,1);
  await removeSession({...f,id,agent:'claude',createClient:()=>{throw new Error('must not start Codex');}});
  assert.equal(fs.existsSync(claude),false);assert.equal(fs.existsSync(codex),true);
});
await check('unknown IDs fail without deleting other sessions',async()=>{
  const f=fixture(),kept=transcript(f,other),client=native();claudeTranscript(f,other);
  await assert.rejects(removeSession({...f,id,createClient:client.createClient}),/Unknown session/);
  assert.equal(fs.existsSync(kept),true);assert.equal(client.calls.some(x=>x.method==='thread/delete'),false);
});
await check('symlinked transcripts, SQLite, indexes and subagent folders are refused',async()=>{
  for(const name of ['sessions','archived_sessions','sqlite','thread-writer-locks','history.jsonl','session_index.jsonl']){
    const f=fixture(),target=path.join(f.base,'outside');fs.writeFileSync(target,'keep');
    fs.rmSync(path.join(f.codexRoot,name),{recursive:true});fs.symlinkSync(target,path.join(f.codexRoot,name));
    await assert.rejects(removeSession({...f,id,agent:'codex'}),/symlinked history/);assert.equal(fs.readFileSync(target,'utf8'),'keep');
  }
  for(const name of [id+'.jsonl',id,'sessions-index.json']){
    const f=fixture(),file=claudeTranscript(f),project=path.dirname(file),target=path.join(f.base,'outside');fs.writeFileSync(target,'keep');
    fs.rmSync(path.join(project,name),{recursive:true,force:true});fs.symlinkSync(target,path.join(project,name));
    await assert.rejects(removeSession({...f,id,agent:'claude'}),/symlinked history/);assert.equal(fs.readFileSync(target,'utf8'),'keep');
  }
});
await check('native deletion errors are never retried or replaced with manual transcript deletion',async()=>{
  const f=fixture(),file=transcript(f),client=native(file,{failure:'Codex history request timed out.'});
  const index=JSON.stringify({id})+'\n';fs.writeFileSync(path.join(f.codexRoot,'session_index.jsonl'),index);
  await assert.rejects(removeSession({...f,id,createClient:client.createClient}),/timed out/);
  assert.equal(fs.existsSync(file),true);assert.equal(fs.readFileSync(path.join(f.codexRoot,'session_index.jsonl'),'utf8'),index);
  assert.equal(client.calls.filter(x=>x.method==='thread/delete').length,1);assert.equal(client.closed,1);
  assert.equal(fs.readdirSync(f.codexRoot).some(name=>name.includes('.cx-remove-')),false);
});
await check('invalid Claude indexes fail before deleting the transcript',async()=>{
  const f=fixture(),file=claudeTranscript(f);fs.writeFileSync(path.join(path.dirname(file),'sessions-index.json'),'{invalid');
  await assert.rejects(removeSession({...f,id,agent:'claude'}));assert.equal(fs.existsSync(file),true);
});
await check('Claude CLI removal infers the agent without querying unrelated Codex history',async()=>{
  const f=fixture(),file=claudeTranscript(f),kept=transcript(f,other);
  const result=spawnSync(process.execPath,[path.join(root,'container/cx-sessions.mjs'),'remove',id],{
    env:{...process.env,CODEX_HOME:f.codexHome,CX_SESSION_CODEX_HISTORY:f.codexRoot,CX_SESSION_CLAUDE_HISTORY:f.claudeRoot},encoding:'utf8',timeout:5000,
  });
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Removed claude session/);
  assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(kept),true);assert.equal(fs.existsSync(f.codexHome),false);
});
await check('terminal interruption closes native work and cleans temporary lookup guards',async()=>{
  const f=fixture(),file=transcript(f),bin=path.join(f.base,'bin'),ready=path.join(f.base,'ready');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
const fs=require('node:fs');const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return;
  if(m.method==='thread/delete'){fs.writeFileSync(process.env.CX_TEST_READY,'ready');return;}
  const result=m.method==='thread/read'?{thread:{id:m.params.threadId,path:process.env.CX_TEST_TRANSCRIPT}}:{};
  console.log(JSON.stringify({id:m.id,result}));
});\n`,{mode:0o755});
  fs.writeFileSync(path.join(f.codexRoot,'history.jsonl'),JSON.stringify({session_id:id})+'\n');
  const child=spawn(process.execPath,[path.join(root,'container/cx-sessions.mjs'),'remove',id,'--agent','codex'],{
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CODEX_HOME:f.codexHome,CX_SESSION_CODEX_HISTORY:f.codexRoot,CX_TEST_TRANSCRIPT:file,CX_TEST_READY:ready},stdio:['ignore','pipe','pipe'],
  });
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{
    const deadline=Date.now()+5000;
    while(!fs.existsSync(ready)&&Date.now()<deadline&&child.exitCode===null)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(fs.existsSync(ready),true,stderr);child.kill('SIGTERM');
    assert.equal(await exited,1,stderr);assert.equal(fs.existsSync(file),true);
    assert.equal(fs.readdirSync(path.join(f.codexRoot,'archived_sessions')).length,0);
    assert.equal(fs.readdirSync(f.codexRoot).some(name=>name.includes('.cx-remove-')),false);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
await check('multiple Codex state versions fail safely before native deletion',async()=>{
  const f=fixture(),file=transcript(f),client=native(file);
  for(const version of [4,5]){const db=new DatabaseSync(path.join(f.codexRoot,'sqlite',`state_${version}.sqlite`));db.close();}
  await assert.rejects(removeSession({...f,id,createClient:client.createClient}),/Multiple Codex state/);
  assert.equal(fs.existsSync(file),true);assert.equal(client.calls.some(x=>x.method==='thread/delete'),false);
});
await check('Codex discovery refuses a different transcript path before deletion',async()=>{
  const f=fixture(),file=transcript(f,other),client=native(file);transcript(f);
  await assert.rejects(removeSession({...f,id,createClient:client.createClient}),/exact managed transcripts/);
  assert.equal(fs.existsSync(file),true);assert.equal(client.calls.some(x=>x.method==='thread/delete'),false);
});
if(process.env.CX_NATIVE_HISTORY==='1'){
  await check('real native Codex deletes active and archived fixtures and their SQLite rows',async()=>{
    for(const archived of [false,true]){
      const f=fixture(),file=transcript(f,id,archived),kept=transcript(f,other);
      const rollout='31234567-89ab-cdef-0123-456789abcdef';
      const immutable=path.join(path.dirname(file),`rollout-2026-11-15T00-00-01-${id}_${rollout}.jsonl`);
      const record=JSON.parse(fs.readFileSync(file,'utf8'));record.payload.rollout_id=rollout;
      fs.writeFileSync(immutable,JSON.stringify(record)+'\n');
      const createClient=realNativeClient;
      assert.equal(await removeSession({...f,id,agent:'codex',createClient}),'codex');
      assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(kept),true);
      assert.equal(fs.existsSync(immutable),false);
      const state=fs.readdirSync(path.join(f.codexRoot,'sqlite')).find(name=>/^state_.*\.sqlite$/.test(name));assert.ok(state);
      const db=new DatabaseSync(path.join(f.codexRoot,'sqlite',state),{readOnly:true});
      try{assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE id=?').get(id).n,0);}finally{db.close();}
    }
  });
  await check('real native Codex removes spawned descendants and keeps unrelated lookalike IDs',async()=>{
    const f=fixture(),parent=transcript(f),childId='21234567-89ab-cdef-0123-456789abcdef',child=transcript(f,childId),kept=transcript(f,other);
    const createClient=(request,options)=>{
      const client=realNativeClient(request,options);
      return {...client,async rpc(method,params){
        const result=await client.rpc(method,params);
        if(method==='thread/read'){
          const state=fs.readdirSync(path.join(f.codexRoot,'sqlite')).find(name=>/^state_.*\.sqlite$/.test(name));
          const db=new DatabaseSync(path.join(f.codexRoot,'sqlite',state));
          try{db.prepare('INSERT INTO thread_spawn_edges(parent_thread_id,child_thread_id,status) VALUES(?,?,?)').run(id,childId,'completed');}finally{db.close();}
        }
        return result;
      }};
    };
    fs.writeFileSync(path.join(f.codexRoot,'history.jsonl'),[id,childId,other].map(session_id=>JSON.stringify({session_id,text:'fixture'})+'\n').join(''));
    await removeSession({...f,id,agent:'codex',createClient});
    assert.equal(fs.existsSync(parent),false);assert.equal(fs.existsSync(child),false);assert.equal(fs.existsSync(kept),true);
    assert.equal(fs.readFileSync(path.join(f.codexRoot,'history.jsonl'),'utf8'),JSON.stringify({session_id:other,text:'fixture'})+'\n');
    assert.equal(fs.readdirSync(path.join(f.codexRoot,'archived_sessions')).length,0);
  });
  await check('exact lookup guards preserve native protection for referenced fork history',async()=>{
    const f=fixture(),file=transcript(f),fork=transcript(f,other);
    const record=JSON.parse(fs.readFileSync(fork,'utf8'));
    record.payload.history_base={thread_id:id,end_ordinal_exclusive:1,end_byte_offset:fs.statSync(file).size};
    fs.writeFileSync(fork,JSON.stringify(record)+'\n');
    await assert.rejects(removeSession({...f,id,agent:'codex',createClient:realNativeClient}),/referenc|fork|attach/);
    assert.equal(fs.existsSync(file),true);assert.equal(fs.existsSync(fork),true);
    assert.equal(fs.readdirSync(path.join(f.codexRoot,'archived_sessions')).length,0);
  });
  await check('real native Codex removes stale SQLite-only sessions without matching another transcript',async()=>{
    const f=fixture(),file=transcript(f),kept=transcript(f,other);
    const client=realNativeClient({config:[]},{env:{...process.env,HOME:f.base,CODEX_HOME:f.codexRoot,CODEX_SQLITE_HOME:path.join(f.codexRoot,'sqlite')}});
    try{
      await client.rpc('initialize',{clientInfo:{name:'cx-stale-history-fixture',version:'1.0.0'}});
      await client.rpc('thread/read',{threadId:id,includeTurns:false});
    }finally{await client.close();}
    const state=fs.readdirSync(path.join(f.codexRoot,'sqlite')).find(name=>/^state_.*\.sqlite$/.test(name));
    let db=new DatabaseSync(path.join(f.codexRoot,'sqlite',state),{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE id=?').get(id).n,1);}finally{db.close();}
    fs.unlinkSync(file);
    await removeSession({...f,id,agent:'codex',createClient:realNativeClient});
    assert.equal(fs.existsSync(kept),true);
    db=new DatabaseSync(path.join(f.codexRoot,'sqlite',state),{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE id=?').get(id).n,0);}finally{db.close();}
  });
}else console.log('SKIP native Codex deletion: set CX_NATIVE_HISTORY=1 to use a real installed binary with disposable fixtures.');
console.log(`\n${count} session removal checks passed; no live provider authentication.`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
