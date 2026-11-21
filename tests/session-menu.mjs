// Menu history discovery/names in disposable stores; never uses account homes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {zstdCompressSync} from 'node:zlib';
import {codexClient,listSessions,renameSession,clean,repairMenuPaths} from '../container/cx-session-menu.mjs';
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
  await test('internal reviewer threads are hidden by source, with an explicit opt-in',async()=>{
    const guardian='33333333-3333-4333-8333-333333333333';
    const queries=[];
    const internalClient={async rpc(method,params){queries.push(params);return {data:[
      {id,name:'Guardian review',source:'cli'},
      {id:guardian,name:'Guardian review',source:{subagent:{other:'guardian_review'}}},
      {id:other,name:'A helper',source:'subAgentReview'}
    ],nextCursor:null};}};
    const visible=await listSessions({codexRoot,client:internalClient});
    assert.deepEqual(visible.map(x=>x.id),[id],'a real user conversation with the same name remains visible');
    assert.equal(visible[0].internal,false);
    assert.ok(queries.every(x=>!x.sourceKinds.includes('subAgentOther')));
    queries.length=0;
    const all=await listSessions({codexRoot,client:internalClient,includeInternal:true});
    assert.equal(all.length,3);assert.equal(all.find(x=>x.id===guardian).internal,true);
    assert.ok(queries.every(x=>x.sourceKinds.includes('subAgentOther')));
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
  await test('repair skips corrupt or truncated rollouts and requires a verified full ID',async()=>{
    const store=path.join(root,'repair'),home=path.join(root,'stable'),dir=path.join(store,'archived_sessions');
    fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(store,'sqlite'));
    const dbFile=path.join(store,'sqlite/state_5.sqlite'),db=new DatabaseSync(dbFile);
    const relative=uuid=>`archived_sessions/rollout-2026-11-15T00-00-00-${uuid}.jsonl.zst`;
    const stale=uuid=>'/tmp/cx-menu-gone01/codex/'+relative(uuid);
    for(const uuid of [id,other]) {
      fs.writeFileSync(path.join(store,relative(uuid)),zstdCompressSync(
        JSON.stringify({type:'session_meta',payload:{id}})+'\n'));
    }
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)');
      const add=db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
      const unrelated='33333333-3333-4333-8333-333333333333';
      const traversal='44444444-4444-4444-8444-444444444444';
      const symlink='55555555-5555-4555-8555-555555555555';
      const corrupt='66666666-6666-4666-8666-666666666666';
      const truncated='77777777-7777-4777-8777-777777777777';
      fs.writeFileSync(path.join(store,relative(corrupt)),'Not a Zstandard frame');
      const compressed=zstdCompressSync(JSON.stringify({type:'session_meta',payload:{id:truncated}})+'\n');
      fs.writeFileSync(path.join(store,relative(truncated)),compressed.subarray(0,5));
      fs.writeFileSync(path.join(root,'outside.zst'),zstdCompressSync(
        JSON.stringify({type:'session_meta',payload:{id:symlink}})+'\n'));
      fs.symlinkSync(path.join(root,'outside.zst'),path.join(store,relative(symlink)));
      add.run(corrupt,stale(corrupt),'Corrupt frame');
      add.run(truncated,stale(truncated),'Truncated frame');
      add.run(id,stale(id),'Keep this title');add.run(other,stale(other),'Wrong metadata ID');
      add.run(unrelated,'/some/other/history.jsonl','Other store');
      add.run(traversal,'/tmp/cx-menu-gone01/codex/sessions/../'+relative(traversal),'Traversal');
      add.run(symlink,stale(symlink),'Symlink');
      await repairMenuPaths(store,home);
      await repairMenuPaths(store,home);
      const read=db.prepare('SELECT * FROM threads WHERE id=?');
      assert.equal(read.get(id).rollout_path,path.join(home,relative(id)));
      assert.equal(read.get(id).title,'Keep this title');
      assert.equal(read.get(other).rollout_path,stale(other));
      assert.equal(read.get(unrelated).rollout_path,'/some/other/history.jsonl');
      assert.match(read.get(traversal).rollout_path,/sessions\/\.\.\//);
      assert.equal(read.get(symlink).rollout_path,stale(symlink));
      assert.equal(read.get(corrupt).rollout_path,stale(corrupt));
      assert.equal(read.get(truncated).rollout_path,stale(truncated));
    } finally {db.close();}
  });
  if(process.env.CX_NATIVE_HISTORY==='1')await test('native Codex listing and naming use supported RPCs without model requests',async()=>{
    const nativeRoot=path.join(root,'native');
    for(const name of ['sessions/2026/11/15','archived_sessions','thread-writer-locks','sqlite'])fs.mkdirSync(path.join(nativeRoot,name),{recursive:true});
    for(const name of ['history.jsonl','session_index.jsonl'])fs.writeFileSync(path.join(nativeRoot,name),'');
    const timestamp='2026-11-15T00:00:00Z';
    const relative=threadId=>`sessions/2026/11/15/rollout-2026-11-15T00-00-00-${threadId}.jsonl`;
    const writeTranscript=threadId=>fs.writeFileSync(path.join(nativeRoot,relative(threadId)),[
      {timestamp,type:'session_meta',payload:{id:threadId,timestamp,cwd:root,originator:'codex-tui',cli_version:'0.169.0',source:'cli',model_provider:'openai'}},
      {timestamp,type:'event_msg',payload:{type:'user_message',message:'Menu fixture',images:[],local_images:[],text_elements:[]}},
      {timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Menu fixture'}]}}
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    writeTranscript(other);
    writeTranscript(id);
    const client=await codexClient(nativeRoot,path.join(root,'native-work'));
    try {
      const rows=await listSessions({codexRoot:nativeRoot,client});assert.ok(rows.some(x=>x.id===id),'Native listing must discover the fixture');
      await renameSession({agent:'codex',id,value:'Native Menu Name',root:nativeRoot,client,rows});
      const page=await client.rpc('thread/list',{limit:100,modelProviders:[],currentAccountOnly:false});
      assert.equal(page.data.find(x=>x.id===id)?.name,'Native Menu Name');
    } finally {await client.close();}
    const home=path.join(root,'native-work');
    const db=new DatabaseSync(path.join(nativeRoot,'sqlite',
      fs.readdirSync(path.join(nativeRoot,'sqlite')).find(name=>/^state_\d+\.sqlite$/.test(name))));
    try {
      const read=db.prepare('SELECT rollout_path FROM threads WHERE id=?');
      const original=read.get(id).rollout_path;
      assert.ok(original.startsWith(home+'/sessions/'));
      const launch=()=>{
        // A new utility container has an empty tmpfs at the same path.
        fs.rmSync(home,{recursive:true,force:true});
        const result=spawnSync(process.execPath,['container/cx-session-menu.mjs'],{
          encoding:'utf8',input:'{"op":"list"}\n',timeout:15000,
          env:{...process.env,CX_SESSION_CODEX_HISTORY:nativeRoot,CX_SESSION_CODEX_HOME:home}
        });
        assert.equal(result.status,0,result.stdout+result.stderr);
        assert.ok(JSON.parse(result.stdout).rows.some(row=>row.id===id));
        assert.equal(read.get(id).rollout_path,original);
      };
      launch();launch();
      assert.ok(read.get(other),'Native listing must index the second fixture');
      const corruptRelative=relative(other)+'.zst';
      fs.unlinkSync(path.join(nativeRoot,relative(other)));
      fs.writeFileSync(path.join(nativeRoot,corruptRelative),'Not a Zstandard frame');
      const corruptPath='/tmp/cx-menu-gone99/codex/'+corruptRelative;
      const stale=db.prepare('UPDATE threads SET rollout_path=? WHERE id=?');
      stale.run(corruptPath,other);
      stale.run('/tmp/cx-menu-gone99/codex/'+path.relative(home,original),id);
      launch();launch();
      assert.equal(read.get(other).rollout_path,corruptPath);
    } finally {db.close();}
  });
  console.log(`${count} menu backend checks passed; no provider calls.`);
} finally {fs.rmSync(root,{recursive:true,force:true});}
