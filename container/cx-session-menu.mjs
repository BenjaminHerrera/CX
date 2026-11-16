// History-only operations for the host menu; no account credentials are mounted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {historyClient, listParams} from './cx-codex-resume.mjs';
import {removeSession} from './cx-sessions.mjs';

export const validId = id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 240);
function safe(file) {
  try { const s=fs.lstatSync(file); if(s.isSymbolicLink())throw Error('Refusing symlinked menu storage.');return s; }
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function names(root,id) {
  const dir=path.join(root,'cx-names');safe(dir);
  const file=path.join(dir,id.toLowerCase()+'.json');safe(file);return {dir,file};
}
function name(root,row) {
  const {file}=names(root,row.id);
  const explicit=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).name:null;
  return clean(explicit || row.name || `Untitled Session [${row.id.slice(0,8)}]`);
}
export async function codexClient(root, work, createClient=historyClient) {
  const home=path.join(work,'codex');fs.mkdirSync(home,{recursive:true});
  for(const item of ['sessions','archived_sessions','thread-writer-locks','session_index.jsonl','history.jsonl']) {
    safe(path.join(root,item));fs.symlinkSync(path.join(root,item),path.join(home,item));
  }
  const client=createClient({config:[]},{env:{...process.env,CODEX_HOME:home,CODEX_SQLITE_HOME:path.join(root,'sqlite')}});
  try {await client.rpc('initialize',{clientInfo:{name:'cx-session-menu',version:'1'},capabilities:{experimentalApi:true}});client.notify('initialized');return client;}
  catch(e){await client.close();throw e;}
}
export async function listSessions({codexRoot,claudeRoot,client}) {
  const rows=[],keys=new Set();
  const add=row=>{const key=row.agent+':'+row.id;if(!keys.has(key)){keys.add(key);rows.push(row);}};
  if(codexRoot && client) {
    for(const archived of [false,true]) {
    const seen=new Set();let cursor=null;
    do {
      const page=await client.rpc('thread/list',{...listParams({noninteractive:true},cursor),limit:100,archived});
      if(!Array.isArray(page?.data))throw Error('Invalid native history page.');
      for(const row of page.data)if(validId(row.id))
        add({agent:'codex',id:row.id.toLowerCase(),name:name(codexRoot,row),project:clean(row.cwd),updated:row.updatedAt??0,archived});
      cursor=page.nextCursor;
      if(cursor && seen.has(cursor))throw Error('Native history pagination repeated a cursor.');
      seen.add(cursor);
      if(seen.size>1000)throw Error('History exceeds the menu limit; narrow history before opening the menu.');
    } while(cursor);
    }
  }
  if(claudeRoot) {
    const projects=path.join(claudeRoot,'projects');safe(projects);
    for(const dir of fs.existsSync(projects)?fs.readdirSync(projects):[]) {
      const project=path.join(projects,dir);if(!safe(project)?.isDirectory())continue;
      const indexFile=path.join(project,'sessions-index.json');safe(indexFile);
      const index=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):{};
      for(const file of fs.readdirSync(project)) {
        const id=file.replace(/\.jsonl$/,'');if(file===id||!validId(id))continue;
        const source=path.join(project,file),stat=safe(source);if(!stat?.isFile())continue;
        const entry=index.entries?.find(x=>x.sessionId?.toLowerCase()===id.toLowerCase());
        // Only explicit native titles count. Summaries and first/last messages
        // are intentionally never used as names. Avoid reading conversation text.
        let title=entry?.customTitle;
        for await (const line of createInterface({input:fs.createReadStream(source),crlfDelay:Infinity})) {
          // Native /rename persists a title metadata record, not a chat preview.
          if(!line.includes('"custom-title"'))continue;
          try {const meta=JSON.parse(line);if(meta.type==='custom-title'&&meta.sessionId?.toLowerCase()===id.toLowerCase())title=meta.customTitle;}catch {}
        }
        const row={agent:'claude',id:id.toLowerCase(),name:title,project:clean(entry?.projectPath??index.originalPath??dir),updated:stat.mtimeMs/1000};
        row.name=name(claudeRoot,row);
        add(row);
      }
    }
  }
  return rows.sort((a,b)=>Number(b.updated)-Number(a.updated)||a.agent.localeCompare(b.agent)||a.id.localeCompare(b.id));
}
export async function renameSession({agent,id,value,root,client,rows}) {
  if(!validId(id)||!['codex','claude'].includes(agent))throw Error('Invalid session identity.');
  if(!rows.some(x=>x.agent===agent&&x.id===id))throw Error('Session no longer exists; refresh the menu.');
  if(typeof value!=='string'||!value.trim()||value.length>200||clean(value)!==value)throw Error('Use a name of 1–200 characters without terminal control characters.');
  const {dir,file}=names(root,id);
  if(agent==='codex')await client.rpc('thread/name/set',{threadId:id,name:value.trim()});
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=path.join(dir,`.${randomUUID()}.tmp`);
  try {fs.writeFileSync(temp,JSON.stringify({name:value.trim()})+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
  finally {fs.rmSync(temp,{force:true});}
}
async function main() {
  let input='';for await(const line of createInterface({input:process.stdin})) {input+=line;if(input.length>16384)throw Error('Menu request too large.');}
  const req=JSON.parse(input),codexRoot=process.env.CX_SESSION_CODEX_HISTORY,claudeRoot=process.env.CX_SESSION_CLAUDE_HISTORY;
  if(req.op!=='list') {
    if(!['codex','claude'].includes(req.agent)||!validId(req.id))throw Error('Mutations require an explicit CLI and full session UUID.');
    req.id=req.id.toLowerCase();
  }
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'cx-menu-'));let client;
  try {
    if(req.op==='remove') {
      await removeSession({id:req.id,agent:req.agent,codexRoot,claudeRoot,codexHome:path.join(work,'remove')});
      const root=req.agent==='codex'?codexRoot:claudeRoot;if(root&&validId(req.id))fs.rmSync(names(root,req.id).file,{force:true});
    } else {
      if(codexRoot)client=await codexClient(codexRoot,work);
      const rows=await listSessions({codexRoot,claudeRoot,client});
      if(req.op==='list') {console.log(JSON.stringify({rows}));return;}
      if(req.op!=='rename')throw Error('Unknown menu operation.');
      await renameSession({...req,root:req.agent==='codex'?codexRoot:claudeRoot,client,rows});
    }
    console.log(JSON.stringify({ok:true}));
  } finally {if(client)await client.close();fs.rmSync(work,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {await main();}catch(e){console.log(JSON.stringify({error:clean(e.message)}));process.exitCode=1;}
}
