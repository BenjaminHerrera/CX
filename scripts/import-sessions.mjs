#!/usr/bin/env node
// Host-side, copy-only migration. Requires Node 24; no packages or provider calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createZstdDecompress} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rollout=/^rollout-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i;
const inside=(a,b)=>a===b||a.startsWith(b+path.sep);
function exists(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function checked(file,type){
  const info=exists(file);if(!info)return null;
  if(info.isSymbolicLink()||(type==='directory'?!info.isDirectory():!info.isFile()))throw new Error(`Refusing unexpected or symlinked ${type}: ${file}`);
  return info;
}
function canonical(file){
  let current=path.resolve(file),tail=[];
  while(!exists(current)){tail.unshift(path.basename(current));current=path.dirname(current);}
  return path.join(fs.realpathSync(current),...tail);
}
function safeParents(file){
  let current=path.dirname(file);
  while(current!==path.dirname(current)){checked(current,'directory');current=path.dirname(current);}
}
function tree(dir){
  if(!checked(dir,'directory'))return [];
  return fs.readdirSync(dir).sort().flatMap(name=>{
    const file=path.join(dir,name),info=exists(file);
    if(info.isSymbolicLink())throw new Error(`Refusing symlinked history: ${file}`);
    if(info.isDirectory())return tree(file);
    checked(file,'file');return [file];
  });
}
function signature(file){const s=checked(file,'file');return s?`${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}`:null;}
async function contents(file,{compressed=false,metadata=false,validate=false}={}){
  const before=signature(file),raw=fs.createReadStream(file),stream=compressed?raw.pipe(createZstdDecompress()):raw;
  if(stream!==raw)raw.on('error',error=>stream.destroy(error));
  const digest=createHash('sha256');let prefix=Buffer.alloc(0),first,bytes=0,completeBytes=0,records=0,missingOrdinals=0;
  let parts=[],partBytes=0;
  const validateLine=line=>{
    if(!line.toString('utf8').trim())return;
    let record;try{record=JSON.parse(line);}catch{throw new Error(`Invalid JSONL transcript record: ${file}`);}
    records++;
    if(record.type!=='session_meta'&&!Number.isSafeInteger(record.ordinal))missingOrdinals++;
  };
  try{
    for await(const chunk of stream){
      digest.update(chunk);
      const lastNewline=chunk.lastIndexOf(10);
      if(lastNewline>=0)completeBytes=bytes+lastNewline+1;
      bytes+=chunk.length;
      if(validate){
        let start=0,end;
        while((end=chunk.indexOf(10,start))>=0){
          parts.push(chunk.subarray(start,end));partBytes+=end-start;
          if(partBytes>128*1024*1024)throw new Error(`Oversized transcript record: ${file}`);
          validateLine(Buffer.concat(parts,partBytes));parts=[];partBytes=0;start=end+1;
        }
        if(start<chunk.length){parts.push(chunk.subarray(start));partBytes+=chunk.length-start;}
        if(partBytes>128*1024*1024)throw new Error(`Oversized transcript record: ${file}`);
      }
      if(metadata&&first===undefined){
        const end=chunk.indexOf(10);prefix=Buffer.concat([prefix,end<0?chunk:chunk.subarray(0,end)]);
        if(prefix.length>1024*1024)throw new Error(`Oversized transcript metadata: ${file}`);
        if(end>=0)first=prefix.toString('utf8');
      }
    }
  }finally{raw.destroy();}
  if(signature(file)!==before)throw new Error(`History changed while reading; stop writers first: ${file}`);
  let record;
  if(metadata){try{record=JSON.parse(first??prefix.toString('utf8'));}catch{throw new Error(`Invalid Codex transcript metadata: ${file}`);}}
  return {digest:digest.digest('hex'),record,signature:before,bytes,completeBytes,records,missingOrdinals};
}
function readJson(file){
  if(!checked(file,'file'))return null;
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error(`Invalid JSON history index: ${file}`);}
}
function readLines(file){
  if(!checked(file,'file'))return [];
  return fs.readFileSync(file,'utf8').split('\n').filter(line=>line.trim()).map(line=>{
    try{return {line,value:JSON.parse(line)};}catch{throw new Error(`Invalid JSONL history index: ${file}`);}
  });
}
function add(groups,id,entry){
  if(!groups.has(id))groups.set(id,{files:new Map()});
  const group=groups.get(id),old=group.files.get(entry.key);
  if(old){
    if(old.digest!==entry.digest)throw new Error(`Conflicting copies of session ${id} within ${entry.agent} history.`);
    return;
  }
  group.files.set(entry.key,entry);
}
function sqliteHistory(home){
  const required=new Set(),cached=new Set(),checkpoints=new Map(),currentRollouts=new Map(),unknown=new Set();
  if(!checked(home,'directory'))return {required,cached,checkpoints,currentRollouts,unknown};
  for(const name of fs.readdirSync(home).filter(name=>/^(?:state|history|thread_history)(?:_\d+)?\.sqlite$/.test(name))){
    // Read a private snapshot so SQLite cannot create source WAL/SHM sidecars.
    const staging=fs.mkdtempSync(path.join(os.tmpdir(),'cx-import-sqlite-'));
    try{
      for(const suffix of ['', '-wal','-shm']){
        const source=path.join(home,name+suffix);if(!checked(source,'file'))continue;
        const before=signature(source);fs.copyFileSync(source,path.join(staging,name+suffix));
        if(signature(source)!==before)throw new Error('Codex SQLite changed; stop native and CX writers before importing.');
      }
      const db=new DatabaseSync(path.join(staging,name),{readOnly:true});
      try{
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
        if(tables.has('threads')){
          const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(x=>x.name));
          if(columns.has('history_mode'))for(const row of db.prepare(`SELECT id,history_mode,${columns.has('rollout_path')?'rollout_path':'NULL AS rollout_path'} FROM threads WHERE history_mode IS NOT NULL AND history_mode!='legacy'`).all()){
            const id=row.id.toLowerCase();required.add(id);
            if(row.history_mode!=='paginated')unknown.add(id);
            if(typeof row.rollout_path==='string'){
              const match=path.basename(row.rollout_path).match(rollout);
              if(match)currentRollouts.set(id,(match[3]||match[2]).toLowerCase());
            }
          }
        }
        for(const name of ['thread_turns','thread_items','thread_realtime_items'])if(tables.has(name)){
          for(const row of db.prepare(`SELECT DISTINCT thread_id FROM ${name}`).all()){
            const id=row.thread_id.toLowerCase();required.add(id);cached.add(id);
          }
        }
        if(tables.has('thread_history_projection_state'))for(const row of db.prepare('SELECT thread_id,next_rollout_byte_offset FROM thread_history_projection_state').all()){
          const id=row.thread_id.toLowerCase(),offset=row.next_rollout_byte_offset;
          if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid Codex SQLite projection checkpoint.');
          checkpoints.set(id,Math.max(checkpoints.get(id)||0,offset));required.add(id);
        }
      }finally{db.close();}
    }finally{fs.rmSync(staging,{recursive:true,force:true});}
  }
  return {required,cached,checkpoints,currentRollouts,unknown};
}
async function codexGroups(home,{source=false,sqliteHome=home,skipUnavailable=false,unavailable=[]}={}){
  const groups=new Map();
  const inventory=source?sqliteHistory(sqliteHome):null;
  for(const namespace of ['sessions','archived_sessions'])for(const file of tree(path.join(home,namespace))){
    const match=path.basename(file).match(rollout);if(!match)continue;
    // Native Codex prefers the plain sibling when both representations exist.
    if(file.endsWith('.zst')&&checked(file.slice(0,-4),'file'))continue;
    const id=match[2].toLowerCase(),rolloutId=(match[3]||match[2]).toLowerCase();
    if(!uuid.test(id)||!uuid.test(rolloutId))throw new Error(`Invalid Codex rollout ID: ${file}`);
    const info=await contents(file,{compressed:file.endsWith('.zst'),metadata:true,validate:source});
    if(info.record?.type!=='session_meta'||info.record.payload?.id?.toLowerCase()!==id)throw new Error(`Codex transcript ID disagrees with filename: ${file}`);
    if(source&&info.record.payload.history_mode&&!['legacy','paginated'].includes(info.record.payload.history_mode))throw new Error(`Codex session ${id} has an unsupported history mode.`);
    add(groups,id,{agent:'codex',key:rolloutId,file,relative:path.relative(home,file),namespace,...info});
  }
  if(source){
    const byRollout=new Map(),missing=new Map();
    for(const [id,group] of groups)for(const [key,entry] of group.files)byRollout.set(key,{id,entry});
    for(const [id,group] of groups)for(const entry of group.files.values()){
      if(entry.record.payload.history_mode==='paginated'&&entry.missingOrdinals)missing.set(id,'paginated records are missing durable ordinals');
    }
    for(const id of inventory.required)if(!groups.has(id)&&!byRollout.has(id))missing.set(id,'no backing rollout file');
    for(const [id,key] of inventory.currentRollouts)if(!groups.get(id)?.files.has(key))missing.set(id,'current rollout referenced by SQLite is missing');
    for(const id of inventory.cached){
      const group=groups.get(id),found=byRollout.get(id);
      if(group&&[...group.files.values()].every(entry=>entry.records<=1))missing.set(id,'cached conversation has no durable body records');
      else if(!group&&found&&found.entry.records<=1)missing.set(found.id,'cached conversation has no durable body records');
    }
    for(const id of inventory.unknown)missing.set(byRollout.get(id)?.id||id,'unsupported SQLite history mode');
    for(const [key,offset] of inventory.checkpoints){
      const found=byRollout.get(key);
      if(found&&offset>found.entry.completeBytes)missing.set(found.id,'rollout is shorter than its cached SQLite history');
      else if(!found&&offset>0&&!groups.has(key))missing.set(key,'cached rollout is missing');
    }
    // A missing ancestor makes its descendants incomplete too, even when the
    // child has its own valid rollout. Never import only the visible suffix.
    let changed=true;
    while(changed){
      changed=false;
      for(const [id,group] of groups)for(const entry of group.files.values()){
        const reference=entry.record.payload.history_base?.thread_id;
        if(reference&&missing.has(byRollout.get(String(reference).toLowerCase())?.id||String(reference).toLowerCase())&&!missing.has(id)){
          missing.set(id,'ancestor history is unavailable');changed=true;
        }
      }
    }
    if(missing.size&&!skipUnavailable){
      const details=[...missing].slice(0,3).map(([id,reason])=>`${id}: ${reason}`).join('; ');
      throw new Error(`Cannot reconstruct ${missing.size} Codex sessions from rollouts (${details}). Nothing copied. Restore missing or complete rollouts, or use --skip-unavailable to import the recoverable sessions.`);
    }
    for(const [id,reason] of missing){groups.delete(id);unavailable.push({id,reason});}
  }
  return groups;
}
async function claudeGroups(home){
  const groups=new Map(),projects=path.join(home,'projects');
  if(!checked(projects,'directory'))return groups;
  for(const project of fs.readdirSync(projects).sort()){
    const directory=path.join(projects,project);checked(directory,'directory');
    for(const name of fs.readdirSync(directory).sort()){
      if(!name.endsWith('.jsonl')||!uuid.test(name.slice(0,-6)))continue;
      const id=name.slice(0,-6).toLowerCase(),file=path.join(directory,name);
      if(groups.has(id))throw new Error(`Claude session ${id} appears in multiple projects; reconcile its copies first.`);
      const info=await contents(file);
      add(groups,id,{agent:'claude',key:'transcript',file,relative:path.relative(home,file),project,...info});
      for(const artifact of tree(path.join(directory,name.slice(0,-6)))){
        add(groups,id,{agent:'claude',key:'artifact:'+path.relative(path.join(directory,name.slice(0,-6)),artifact),file:artifact,relative:path.relative(home,artifact),project,...await contents(artifact)});
      }
    }
  }
  return groups;
}
const stable=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):value);
function privateParents(directory){
  if(checked(directory,'directory'))return;
  privateParents(path.dirname(directory));fs.mkdirSync(directory,{mode:0o700});
}

export async function importSessions({dataHome,codexHome,claudeHome,codexSqliteHome=codexHome,agent='all',dryRun=false,onConflict='error',skipUnavailable=false}){
  if(!['all','codex','claude'].includes(agent)||!['error','skip'].includes(onConflict))throw new Error('Invalid agent or conflict policy.');
  dataHome=canonical(dataHome);
  if(dataHome===path.parse(dataHome).root||dataHome.includes(','))throw new Error('Invalid CX data directory.');
  const sources={codex:canonical(codexHome),claude:canonical(claudeHome)},selected=agent==='all'?['codex','claude']:[agent];
  const protectedHomes=[...Object.values(sources),canonical(path.join(os.homedir(),'.codex')),canonical(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'))];
  for(const home of protectedHomes)if(inside(dataHome,home)||inside(home,dataHome))throw new Error('Native homes and CX data must not overlap.');
  safeParents(path.join(dataHome,'history','probe'));
  if(exists(path.join(dataHome,'.import-sessions.lock')))throw new Error('Another session import is active; inspect the import lock before retrying.');
  const copies=[],edits=[],conflicts=[],unavailable=[],accepted={codex:new Set(),claude:new Set()},routes=new Map(),claudeNames=new Map();
  const observed=new Map();
  let identical=0,sessions=0;
  const observe=file=>{if(!observed.has(file))observed.set(file,signature(file));};
  const edit=(file,updated)=>{
    safeParents(file);observe(file);
    if(!exists(file)||fs.readFileSync(file,'utf8')!==updated)edits.push({file,updated});
  };
  for(const cli of selected){
    const target=path.join(dataHome,'history',cli);checked(target,'directory');
    const source=cli==='codex'?await codexGroups(sources.codex,{source:true,sqliteHome:canonical(codexSqliteHome),skipUnavailable,unavailable}):await claudeGroups(sources.claude);
    const existing=cli==='codex'?await codexGroups(target):await claudeGroups(target);
    const rejected=new Set();
    if(cli==='codex'){
      const targetHistory=sqliteHistory(path.join(target,'sqlite'));
      for(const id of targetHistory.required)if(source.has(id)&&!existing.has(id))rejected.add(id);
      for(const [id,key] of targetHistory.currentRollouts)if(source.has(id)&&!existing.get(id)?.files.has(key))rejected.add(id);
    }
    for(const [id,group] of source)if([...group.files].some(([key,entry])=>existing.get(id)?.files.has(key)&&existing.get(id).files.get(key).digest!==entry.digest))rejected.add(id);
    if(cli==='codex'){
      const sourceRollouts=new Map(),targetRollouts=new Set();
      const unavailableIds=new Set(unavailable.map(entry=>entry.id));
      const omit=(id,reason)=>{unavailableIds.add(id);rejected.add(id);unavailable.push({id,reason});};
      for(const [id,group] of source)for(const key of group.files.keys())sourceRollouts.set(key,id);
      for(const group of existing.values())for(const key of group.files.keys())targetRollouts.add(key);
      let changed=true;
      while(changed){
        changed=false;
        for(const [id,group] of source)for(const entry of group.files.values()){
          if(unavailableIds.has(id))continue;
          const reference=entry.record?.payload?.history_base?.thread_id;if(!reference)continue;
          const key=String(reference).toLowerCase(),parent=sourceRollouts.get(key);
          let issue;
          if(!parent&&!targetRollouts.has(key))issue='missing ancestor rollout';
          else{
            const ancestor=parent?source.get(parent).files.get(key):[...existing.values()].map(group=>group.files.get(key)).find(Boolean);
            observe(ancestor.file);
            const cutoff=entry.record.payload.history_base.end_byte_offset;
            if(!Number.isSafeInteger(cutoff)||cutoff<0||cutoff>ancestor.completeBytes)issue='truncated ancestor rollout';
          }
          if(issue){
            if(!skipUnavailable)throw new Error(`Codex session ${id} references a ${issue}; restore complete rollouts or use --skip-unavailable.`);
            omit(id,issue);changed=true;continue;
          }
          if(parent&&rejected.has(parent)&&!rejected.has(id)){
            if(unavailableIds.has(parent))omit(id,'ancestor history is unavailable');
            else rejected.add(id);
            changed=true;
          }
        }
      }
    }
    for(const [id,group] of source){
      const current=existing.get(id),first=current?.files.values().next().value;
      if(rejected.has(id)){
        if(cli!=='codex'||!unavailable.some(entry=>entry.id===id))conflicts.push(`${cli}/${id}`);
        continue;
      }
      accepted[cli].add(id);sessions++;
      if(cli==='claude'){
        routes.set(id,first?.project??group.files.values().next().value.project);
        claudeNames.set(id,path.basename(current?.files.get('transcript').file??group.files.get('transcript').file));
      }
      for(const [key,entry] of group.files){
        observe(entry.file);
        if(current?.files.has(key)){observe(current.files.get(key).file);identical++;continue;}
        let relative=entry.relative;
        if(first&&cli==='claude')relative=path.join('projects',first.project,path.relative(path.join('projects',entry.project),relative));
        if(first&&cli==='codex'&&first.namespace!==entry.namespace){
          const match=path.basename(entry.file).match(rollout);
          relative=first.namespace==='archived_sessions'?path.join(first.namespace,path.basename(entry.file)):path.join(first.namespace,...match[1].split('-'),path.basename(entry.file));
        }
        const file=path.join(target,relative);safeParents(file);
        if(exists(file))throw new Error(`Destination exists outside the recognized session layout: ${file}`);
        observe(file);copies.push({...entry,target:file});
      }
    }
  }
  if(conflicts.length&&onConflict==='error')throw new Error(`Different content already exists for ${conflicts.join(', ')}. Nothing copied. Use --on-conflict skip to preserve those CX sessions and import the rest.`);
  if(selected.includes('codex'))for(const [name,key,byId] of [['history.jsonl','session_id',false],['session_index.jsonl','id',true]]){
    const source=path.join(sources.codex,name),target=path.join(dataHome,'history/codex',name);
    observe(source);observe(target);
    const incoming=readLines(source).filter(row=>accepted.codex.has(String(row.value?.[key]).toLowerCase())),existing=readLines(target);
    const seen=new Set(existing.map(row=>byId?String(row.value?.[key]).toLowerCase():stable(row.value)));
    const additions=[];
    // The final source name entry is the most recent for an append-only index.
    for(const row of byId?incoming.toReversed():incoming){
      const identity=byId?String(row.value[key]).toLowerCase():stable(row.value);
      if(!seen.has(identity)){additions.push(row.line);seen.add(identity);}
    }
    if(additions.length){const original=exists(target)?fs.readFileSync(target,'utf8'):'';edit(target,original+(original&&!original.endsWith('\n')?'\n':'')+additions.join('\n')+'\n');}
  }
  if(selected.includes('claude')){
    const projects=path.join(sources.claude,'projects'),incoming=new Map();
    if(checked(projects,'directory'))for(const name of fs.readdirSync(projects)){
      const file=path.join(projects,name,'sessions-index.json');observe(file);const index=readJson(file);if(!index)continue;
      if(!Array.isArray(index.entries))throw new Error(`Invalid Claude session index: ${file}`);
      for(const row of index.entries){
        const id=String(row.sessionId).toLowerCase();if(!accepted.claude.has(id))continue;
        const project=routes.get(id);if(!incoming.has(project))incoming.set(project,[]);
        incoming.get(project).push({...row,fullPath:`/cx-history/projects/${project}/${claudeNames.get(id)}`});
      }
    }
    for(const [project,rows] of incoming){
      const target=path.join(dataHome,'history/claude/projects',project,'sessions-index.json');observe(target);
      const index=readJson(target)||{version:1,entries:[]};
      if(!Array.isArray(index.entries))throw new Error(`Invalid Claude session index: ${target}`);
      const seen=new Set(index.entries.map(row=>String(row.sessionId).toLowerCase())),additions=[];
      for(const row of rows){const id=row.sessionId.toLowerCase();if(!seen.has(id)){seen.add(id);additions.push(row);}}
      if(additions.length)edit(target,JSON.stringify({...index,entries:[...index.entries,...additions]},null,2)+'\n');
    }
  }
  const result={sessions,files:copies.length,indexes:edits.length,identical,conflicts,unavailable,dryRun};
  if(dryRun||(!copies.length&&!edits.length))return result;
  for(const [file,before] of observed)if(signature(file)!==before)throw new Error(`History changed during planning; stop writers first: ${file}`);
  privateParents(dataHome);
  const lock=path.join(dataHome,'.import-sessions.lock');
  const handle=fs.openSync(lock,'wx',0o600);let staging;
  try{
    fs.writeFileSync(handle,`${process.pid}\n`);staging=fs.mkdtempSync(path.join(dataHome,'.import-sessions-'));
    // Stage complete copies before publishing; original files are never linked
    // into CX, so future CX writes cannot mutate native conversations.
    for(const [i,entry] of copies.entries()){
      entry.staged=path.join(staging,`file-${i}`);fs.copyFileSync(entry.file,entry.staged);fs.chmodSync(entry.staged,0o600);
      const actual=await contents(entry.staged,{compressed:entry.agent==='codex'&&entry.file.endsWith('.zst')});
      if(actual.digest!==entry.digest)throw new Error(`Source history changed during copy: ${entry.file}`);
    }
    for(const [i,entry] of edits.entries()){
      entry.staged=path.join(staging,`index-${i}`);fs.writeFileSync(entry.staged,entry.updated,{flag:'wx',mode:0o600});
    }
    for(const [file,before] of observed)if(signature(file)!==before)throw new Error(`History changed during staging; stop writers first: ${file}`);
    for(const entry of copies){safeParents(entry.target);privateParents(path.dirname(entry.target));fs.linkSync(entry.staged,entry.target);}
    for(const entry of edits){safeParents(entry.file);privateParents(path.dirname(entry.file));fs.renameSync(entry.staged,entry.file);}
  }finally{fs.closeSync(handle);if(staging)fs.rmSync(staging,{recursive:true,force:true});fs.unlinkSync(lock);}
  return result;
}

async function main(){
  const {values}=parseArgs({options:{'dry-run':{type:'boolean'},'skip-unavailable':{type:'boolean'},help:{type:'boolean',short:'h'},agent:{type:'string'},'on-conflict':{type:'string'},'data-home':{type:'string'},'codex-home':{type:'string'},'claude-home':{type:'string'},'codex-sqlite-home':{type:'string'}}});
  if(values.help){console.log(`Usage: node scripts/import-sessions.mjs [options]

Copy native histories into CX shared history. Stop native and CX writers first.
  --dry-run                 Preview without writing CX or native data
  --agent codex|claude|all   Default: all
  --data-home DIR           CX_DATA_HOME or ~/.local/share/cx/data
  --codex-home DIR          CODEX_HOME or ~/.codex
  --claude-home DIR         CLAUDE_CONFIG_DIR or ~/.claude
  --codex-sqlite-home DIR   CODEX_SQLITE_HOME or the selected Codex home
  --on-conflict error|skip   Default: error; existing conversations never replaced
  --skip-unavailable         Explicitly skip missing/truncated SQLite-backed history

Copies transcripts, session artifacts and matching indexes only. Keeps originals;
excludes credentials, settings and SQLite databases. Use Node 24.`);return;}
  const codexHome=values['codex-home']||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const dataHome=values['data-home']||process.env.CX_DATA_HOME||path.join(os.homedir(),'.local/share/cx/data');
  const result=await importSessions({dataHome,codexHome,claudeHome:values['claude-home']||process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),codexSqliteHome:values['codex-sqlite-home']||(!values['codex-home']&&process.env.CODEX_SQLITE_HOME)||codexHome,agent:values.agent||'all',onConflict:values['on-conflict']||'error',dryRun:values['dry-run']||false,skipUnavailable:values['skip-unavailable']||false});
  console.log(`${result.dryRun?'Would import':'Imported'} ${result.sessions} sessions: ${result.files} new files, ${result.indexes} index updates; ${result.identical} identical files already present, ${result.conflicts.length} conflicting sessions skipped, ${result.unavailable.length} unavailable sessions skipped.`);
  for(const conflict of result.conflicts)console.log(`Kept existing CX session: ${conflict}`);
  for(const entry of result.unavailable)console.log(`Skipped unavailable Codex session ${entry.id}: ${entry.reason}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await main();}catch(error){console.error(`cx import: ${error.message}`);process.exitCode=1;}
}
