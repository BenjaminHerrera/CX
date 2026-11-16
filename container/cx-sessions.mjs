#!/usr/bin/env node
// Local history maintenance. The host mounts histories, never account homes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {historyClient} from './cx-codex-resume.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same=(value,id)=>typeof value==='string'&&value.toLowerCase()===id;
const rolloutName=/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const rolloutId=file=>path.basename(file).match(rolloutName)?.[1].toLowerCase();
function stat(file){
  let value;
  try{value=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(value.isSymbolicLink())throw new Error(`Refusing symlinked history: ${file}`);
  if(!value.isFile()&&!value.isDirectory())throw new Error(`Invalid history entry: ${file}`);
  return value;
}
function directory(file){
  const value=stat(file);
  if(value&&!value.isDirectory())throw new Error(`Expected history directory: ${file}`);
  return !!value;
}
function files(directoryPath){
  if(!directory(directoryPath))return [];
  return fs.readdirSync(directoryPath).flatMap(name=>{
    const file=path.join(directoryPath,name),value=stat(file);
    return value.isDirectory()?files(file):[file];
  });
}
function jsonlEdit(file,ids,key){
  const value=stat(file);if(!value)return null;
  if(!value.isFile())throw new Error(`Expected history file: ${file}`);
  const original=fs.readFileSync(file,'utf8');
  const updated=(original.match(/[^\n]*\n|[^\n]+$/g)||[]).filter(line=>{
    try{return !ids.has(String(JSON.parse(line)[key]).toLowerCase());}catch{return true;}
  }).join('');
  return updated===original?null:{file,updated};
}
function stateFiles(root){
  const states=files(path.join(root,'sqlite')).filter(file=>/^state_\d+\.sqlite$/.test(path.basename(file)));
  if(states.length>1)throw new Error('Multiple Codex state database versions found; back up history and retain the state database used by the installed Codex version before removing sessions.');
  return states;
}
function storedThread(root,id){
  for(const file of stateFiles(root)){
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get()
        &&db.prepare('SELECT 1 FROM threads WHERE id=?').get(id))return true;
    }finally{db.close();}
  }
  return false;
}
function deletionIds(root,id){
  const edges=new Map(),ids=new Set([id]);
  for(const file of stateFiles(root)){
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get())continue;
      for(const row of db.prepare('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges').all()){
        if(!uuid.test(row.parent_thread_id)||!uuid.test(row.child_thread_id))throw new Error('Invalid Codex session relationships.');
        const parent=row.parent_thread_id.toLowerCase(),child=row.child_thread_id.toLowerCase();
        if(!edges.has(parent))edges.set(parent,[]);edges.get(parent).push(child);
      }
    }finally{db.close();}
  }
  for(const parent of ids)for(const child of edges.get(parent)||[])ids.add(child);
  return ids;
}
function exactLookupGuards(root,ids,transcripts,guards){
  // Codex 0.169's absent-namespace lookup can fuzzy-match another UUID. Give
  // native deletion an exact metadata-only match in BOTH namespaces so its
  // fallback cannot select an unrelated rollout. These files contain no chat.
  for(const name of ['sessions','archived_sessions']){
    const directoryPath=path.join(root,name);fs.mkdirSync(directoryPath,{recursive:true,mode:0o700});
    for(const id of ids){
      if(transcripts.some(file=>file.startsWith(directoryPath+path.sep)&&rolloutId(file)===id))continue;
      // A unique rollout ID avoids shadowing an original in the native
      // reference index when one thread has multiple immutable rollouts.
      const rollout_id=randomUUID();
      const file=path.join(directoryPath,`rollout-2000-01-01T00-00-00-${id}_${rollout_id}.jsonl`);
      fs.writeFileSync(file,JSON.stringify({timestamp:'2000-01-01T00:00:00Z',type:'session_meta',payload:{id,rollout_id,timestamp:'2000-01-01T00:00:00Z',cwd:'/',originator:'cx-session-removal',cli_version:'0.169.0',source:'cli',model_provider:'openai'}})+'\n',{flag:'wx',mode:0o600});
      guards.push(file);
    }
  }
}
function claudeSession(root,id){
  if(!root)return null;
  directory(root);
  const projects=path.join(root,'projects'),transcripts=[],trees=[],edits=[];
  if(!directory(projects))return null;
  for(const name of fs.readdirSync(projects)){
    const project=path.join(projects,name);if(!directory(project))continue;
    for(const entry of fs.readdirSync(project)){
      if(entry.toLowerCase()===`${id}.jsonl`){
        const file=path.join(project,entry);if(!stat(file).isFile())throw new Error('Invalid Claude transcript.');
        transcripts.push(file);
      }else if(entry.toLowerCase()===id){
        const tree=path.join(project,entry);files(tree);trees.push(tree);
      }
    }
    const index=path.join(project,'sessions-index.json');
    const value=stat(index);if(!value)continue;
    if(!value.isFile())throw new Error('Invalid Claude session index.');
    const original=JSON.parse(fs.readFileSync(index,'utf8'));
    if(!Array.isArray(original.entries))throw new Error('Invalid Claude session index.');
    const entries=original.entries.filter(row=>!same(row.sessionId,id));
    if(entries.length!==original.entries.length)edits.push({file:index,updated:JSON.stringify({...original,entries},null,2)+'\n'});
  }
  return transcripts.length||trees.length||edits.length?{transcripts,trees,edits}:null;
}
async function codexSession(root,id,home,createClient){
  if(!root)return null;
  directory(root);
  // Validate paths before starting native discovery/deletion. Never follow a
  // user-provided history symlink, including SQLite/WAL and archive entries.
  const allTranscripts=['sessions','archived_sessions'].flatMap(name=>files(path.join(root,name)));
  const transcripts=allTranscripts.filter(file=>rolloutId(file)===id);
  files(path.join(root,'sqlite'));
  files(path.join(root,'thread-writer-locks'));
  // Validate index files before native discovery can touch them.
  for(const name of ['session_index.jsonl','history.jsonl'])jsonlEdit(path.join(root,name),new Set([id]),name==='history.jsonl'?'session_id':'id');
  const stored=storedThread(root,id);
  // Do not let native fuzzy discovery mistake another conversation for an
  // absent ID, especially when inferring Claude against an existing Codex store.
  if(!transcripts.length&&!stored)return null;
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  for(const name of ['sessions','archived_sessions','thread-writer-locks','history.jsonl','session_index.jsonl']){
    const link=path.join(home,name),target=path.join(root,name);
    if(fs.existsSync(link)||fs.lstatSync(home).isSymbolicLink())throw new Error('Session maintenance requires an empty temporary Codex home.');
    fs.symlinkSync(target,link);
  }
  const client=createClient({config:[]},{env:{...process.env,HOME:home,CODEX_HOME:home,CODEX_SQLITE_HOME:path.join(root,'sqlite')}});
  const close=client.close.bind(client);
  const interrupted=()=>{void client.close();};
  // Closing the RPC client rejects pending work, allowing the outer finally to
  // clean staged files and lookup guards after ordinary terminal interrupts.
  client.close=async()=>{
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
    await close();
  };
  process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  try{
    await client.rpc('initialize',{clientInfo:{name:'cx-session-removal',version:'1.0.0'},capabilities:{experimentalApi:true}});
    client.notify('initialized');
    let result;
    try{result=await client.rpc('thread/read',{threadId:id,includeTurns:false});}
    catch(error){
      if(!transcripts.length&&stored&&new RegExp(`^(thread not loaded: |thread not found: )${id}$`,'i').test(error.message))result={thread:{id,path:null}};
      else throw error;
    }
    if(!same(result?.thread?.id,id))throw new Error('Codex returned a different session ID.');
    if(result.thread.path){
      let actual,roots=[root];
      try{actual=fs.realpathSync(result.thread.path);}
      catch(error){
        if(error.code!=='ENOENT'||transcripts.length||!stored)throw error;
        // A stale SQLite row can outlive its transcript. Allow native cleanup
        // only for an exact ID and a path in our managed home/history roots.
        actual=path.resolve(result.thread.path);roots.push(home);
      }
      if(!roots.some(base=>['sessions','archived_sessions'].some(name=>actual.startsWith(path.join(base,name)+path.sep)))||rolloutId(actual)!==id)throw new Error('Codex session points outside its exact managed transcripts.');
    }
    const ids=deletionIds(root,id);
    const edits=[jsonlEdit(path.join(root,'session_index.jsonl'),ids,'id'),jsonlEdit(path.join(root,'history.jsonl'),ids,'session_id')].filter(Boolean);
    return {client,transcripts:[],allTranscripts,edits,ids};
  }catch(error){await client.close();throw error;}
}

export async function removeSession({id,agent,codexRoot,claudeRoot,codexHome,createClient=historyClient}){
  if(!uuid.test(id))throw new Error('Use the full session UUID.');
  id=id.toLowerCase();
  if(agent&&!['codex','claude'].includes(agent))throw new Error('Invalid --agent.');
  let codex;
  const staged=[],guards=[];
  try{
    // Complete discovery and validation before deleting anything. A collision
    // across CLIs must never implicitly remove both conversations.
    const claude=agent==='codex'?null:claudeSession(claudeRoot,id);
    codex=agent==='claude'?null:await codexSession(codexRoot,id,codexHome,createClient);
    if(codex&&claude)throw new Error('Session ID exists for both CLIs; specify --agent codex or --agent claude.');
    if(!codex&&!claude)throw new Error(`Unknown session: ${id}`);
    const selected=codex||claude;
    for(const edit of selected.edits){
      const temporary=edit.file+`.cx-remove-${randomUUID()}`;
      staged.push({temporary,file:edit.file});
      fs.writeFileSync(temporary,edit.updated,{flag:'wx',mode:0o600});
    }
    if(codex){
      exactLookupGuards(codexRoot,codex.ids,codex.allTranscripts,guards);
      // Native deletion owns SQLite, transcript and thread relationship cleanup.
      // Never fall back to hand-editing databases or retry an uncertain RPC.
      await codex.client.rpc('thread/delete',{threadId:id});
    }
    for(const file of selected.transcripts)fs.rmSync(file,{force:true});
    for(const tree of selected.trees||[])fs.rmSync(tree,{recursive:true});
    for(const {temporary,file} of staged)fs.renameSync(temporary,file);
    return codex?'codex':'claude';
  }finally{
    try{if(codex)await codex.client.close();}
    finally{
      for(const file of guards)fs.rmSync(file,{force:true});
      for(const {temporary} of staged)fs.rmSync(temporary,{force:true});
    }
  }
}

async function main(){
  const args=process.argv.slice(2);
  if(args[0]!=='remove'||![2,4].includes(args.length)||(args.length===4&&args[2]!=='--agent'))throw new Error('Usage: cx sessions remove ID [--agent codex|claude]');
  const agent=await removeSession({id:args[1],agent:args[3],codexRoot:process.env.CX_SESSION_CODEX_HISTORY,claudeRoot:process.env.CX_SESSION_CLAUDE_HISTORY,codexHome:process.env.CODEX_HOME});
  console.log(`Removed ${agent} session ${args[1]}. This affects shared history for all ${agent} accounts.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await main();}catch(error){console.error(`cx: ${error.message} Session removal is not retried automatically.`);process.exitCode=1;}
}
