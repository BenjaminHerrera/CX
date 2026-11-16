// Menu history discovery/names in disposable stores; never uses account homes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexClient,listSessions,renameSession,clean} from '../container/cx-session-menu.mjs';
import {removeSession} from '../container/cx-sessions.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx-menu-test-'));
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
let count=0;const test=async(name,fn)=>{await fn();console.log(`ok ${++count} - ${name}`);};
try {
  const codexRoot=path.join(root,'codex'),claudeRoot=path.join(root,'claude'),project=path.join(claudeRoot,'projects','fixture');
  fs.mkdirSync(codexRoot);fs.mkdirSync(project,{recursive:true});
  const transcript=path.join(project,id+'.jsonl');
  fs.writeFileSync(transcript,JSON.stringify({type:'user',message:{content:'Changing chat preview'}})+'\n'+JSON.stringify({type:'custom-title',sessionId:id,customTitle:'Native Name'})+'\n');
  fs.writeFileSync(path.join(project,'sessions-index.json'),JSON.stringify({originalPath:'/project',entries:[{sessionId:id,summary:'Never a name'}]}));
  const calls=[];
  const client={async rpc(method,params){calls.push({method,params});if(method==='thread/list')return params.cursor?{data:[{id:other,name:'Duplicate',updatedAt:1}],nextCursor:null}:{data:[{id,preview:'Changing Codex message',cwd:'/project',updatedAt:2}],nextCursor:'next'};return {};}};
  await test('native pagination and CLI namespaces keep duplicate UUIDs distinct',async()=>{
    const rows=await listSessions({codexRoot,claudeRoot,client});assert.equal(rows.length,3);
    assert.equal(rows.find(x=>x.agent==='codex'&&x.id===id).name,'Untitled Session [11111111]');
    assert.equal(rows.find(x=>x.agent==='claude').name,'Native Name');
    assert.ok(calls.some(x=>x.params.cursor==='next'));
    assert.ok(calls.some(x=>x.params.archived===true));
  });
  await test('explicit Unicode names persist over new messages/native titles and CLI restarts',async()=>{
    let rows=await listSessions({codexRoot,claudeRoot,client});
    const before=fs.readFileSync(transcript,'utf8');
    await renameSession({agent:'claude',id,value:'計画 🐈',root:claudeRoot,rows});
    assert.equal(fs.readFileSync(transcript,'utf8'),before);
    fs.appendFileSync(transcript,JSON.stringify({type:'custom-title',sessionId:id,customTitle:'A later imported title'})+'\n');
    rows=await listSessions({codexRoot,claudeRoot,client});assert.equal(rows.find(x=>x.agent==='claude').name,'計画 🐈');
    assert.equal(rows.find(x=>x.agent==='codex'&&x.id===id).name,'Untitled Session [11111111]');
    await renameSession({agent:'codex',id,value:'Duplicate',root:codexRoot,client,rows});
    assert.ok(calls.some(x=>x.method==='thread/name/set'&&x.params.threadId===id&&x.params.name==='Duplicate'));
    rows=await listSessions({codexRoot,claudeRoot,client});assert.equal(rows.filter(x=>x.name==='Duplicate').length,2);
  });
  await test('stale IDs, terminal escapes and symlinked metadata cannot be renamed',async()=>{
    const rows=await listSessions({codexRoot,claudeRoot,client});
    for(const value of ['','evil\x1b[31m','spoof\u202e'])await assert.rejects(renameSession({agent:'claude',id,value,root:claudeRoot,rows}));
    await assert.rejects(renameSession({agent:'claude',id:other,value:'stale',root:claudeRoot,rows}));
    assert.equal(clean('evil\x1b[31m').includes('\x1b'),false);
    const file=path.join(claudeRoot,'cx-names',id+'.json');fs.unlinkSync(file);fs.symlinkSync(transcript,file);
    await assert.rejects(listSessions({claudeRoot}),/symlink/);fs.unlinkSync(file);
  });
  await test('Claude writer leases and deletion locks protect active histories',async()=>{
    const live=path.join(claudeRoot,'cx-live');fs.mkdirSync(live);fs.writeFileSync(path.join(live,'instance.json'),'{}');
    await assert.rejects(removeSession({id,agent:'claude',claudeRoot}),/writing/);assert.ok(fs.existsSync(transcript));
    fs.rmSync(live,{recursive:true});
    const lock=path.join(claudeRoot,'cx-delete-lock');fs.mkdirSync(lock);
    await assert.rejects(removeSession({id,agent:'claude',claudeRoot}));assert.ok(fs.existsSync(lock));assert.ok(fs.existsSync(transcript));
    fs.rmdirSync(lock);await removeSession({id,agent:'claude',claudeRoot});assert.equal(fs.existsSync(transcript),false);
    assert.equal(fs.existsSync(lock),false);
  });
  if(process.env.CX_NATIVE_HISTORY==='1')await test('native Codex listing and naming use supported RPCs without model requests',async()=>{
    const nativeRoot=path.join(root,'native');
    for(const name of ['sessions/2026/11/15','archived_sessions','thread-writer-locks','sqlite'])fs.mkdirSync(path.join(nativeRoot,name),{recursive:true});
    for(const name of ['history.jsonl','session_index.jsonl'])fs.writeFileSync(path.join(nativeRoot,name),'');
    const timestamp='2026-11-15T00:00:00Z';
    fs.writeFileSync(path.join(nativeRoot,'sessions/2026/11/15',`rollout-2026-11-15T00-00-00-${id}.jsonl`),[
      {timestamp,type:'session_meta',payload:{id,timestamp,cwd:root,originator:'codex-tui',cli_version:'0.169.0',source:'cli',model_provider:'openai'}},
      {timestamp,type:'event_msg',payload:{type:'user_message',message:'Menu fixture',images:[],local_images:[],text_elements:[]}},
      {timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Menu fixture'}]}}
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const client=await codexClient(nativeRoot,path.join(root,'native-work'));
    try {
      const rows=await listSessions({codexRoot:nativeRoot,client});assert.ok(rows.some(x=>x.id===id),'Native listing must discover the fixture');
      await renameSession({agent:'codex',id,value:'Native Menu Name',root:nativeRoot,client,rows});
      const page=await client.rpc('thread/list',{limit:100,modelProviders:[],currentAccountOnly:false});
      assert.equal(page.data.find(x=>x.id===id)?.name,'Native Menu Name');
    } finally {await client.close();}
  });
  console.log(`${count} menu backend checks passed; no provider calls.`);
} finally {fs.rmSync(root,{recursive:true,force:true});}
