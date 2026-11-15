#!/usr/bin/env node
// Real Codex account-policy regression with synthetic identities and rollouts.
// No real credentials, provider calls, ownership rewrites or policy bypasses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pickerRequest,chooseHistory,historyClient} from '../container/cx-codex-resume.mjs';

if(process.env.CX_NATIVE_HISTORY!=='1'){
  console.log('SKIP Codex subscription history: set CX_NATIVE_HISTORY=1 to run against a real Codex binary.');
  process.exit(0);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-subscription-'));
const sessions=path.join(temp,'sessions');fs.mkdirSync(sessions);
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CX_')&&!/^(CODEX|OPENAI|CLAUDE|ANTHROPIC|AWS|GOOGLE)/.test(key)));
const jwt=claims=>Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.c2lnbmF0dXJl';
function home(identity){
  const dir=path.join(temp,identity);fs.mkdirSync(dir);fs.symlinkSync(sessions,path.join(dir,'sessions'));
  const token=jwt({'https://api.openai.com/auth':{chatgpt_user_id:identity,chatgpt_account_id:identity,chatgpt_plan_type:'plus'},exp:Math.floor(Date.now()/1000)+3600});
  fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{id_token:token,access_token:token,refresh_token:'fixture-refresh',account_id:identity},last_refresh:new Date().toISOString()}),{mode:0o600});
  return dir;
}
function rollout(owner,scoped){
  const id=randomUUID(),timestamp=new Date().toISOString();
  const day=path.join(sessions,...timestamp.slice(0,10).split('-'));fs.mkdirSync(day,{recursive:true});
  const filename=path.join(day,`rollout-${timestamp.slice(0,19).replaceAll(':','-')}-${id}.jsonl`);
  const lines=[
    {timestamp,type:'session_meta',payload:{id,timestamp,cwd:temp,originator:'codex-tui',cli_version:'0.169.0',source:'cli',model_provider:'openai',account_scoped:scoped,creator_user_id:owner,creator_account_id:owner}},
    {timestamp,type:'event_msg',payload:{type:'user_message',message:'Subscription history fixture',images:[],local_images:[],text_elements:[]}},
    {timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Subscription history fixture'}]}},
  ];
  fs.writeFileSync(filename,lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return {id,filename,metadata:lines[0]};
}
function client(dir){
  // Enable the upstream ownership check to cover installations where it is
  // rolled out. Never disable it or impersonate a third-party client to resume.
  const child=spawn(process.env.CX_NATIVE_CODEX||'codex',['app-server','-c','features.cli_resume_account_check=true','-c','cli_auth_credentials_store="file"','-c','chatgpt_base_url="http://127.0.0.1:9"'],{cwd:temp,env:{...clean,HOME:dir,CODEX_HOME:dir,CODEX_SQLITE_HOME:path.join(temp,'sqlite'),HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});
  let buffer='',next=0,stderr='';const pending=new Map();
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}
    }
  });
  child.on('error',error=>{for(const resolve of pending.values())resolve({error:{message:error.message}});pending.clear();});
  const timer=setTimeout(()=>{for(const resolve of pending.values())resolve({error:{message:'Native policy check timed out: '+stderr.slice(-1000)}});pending.clear();child.kill('SIGKILL');},20000);
  return {
    rpc(method,params){return new Promise(resolve=>{const id=++next;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,method,params})+'\n');});},
    async close(){clearTimeout(timer);if(child.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}},
  };
}
const clients=[];
try{
  const a=home('fixture-owner-a'),b=home('fixture-owner-b');
  const owned=rollout('fixture-owner-a',true),other=rollout('fixture-owner-b',true),legacy=rollout('fixture-owner-a',false);
  for(const [dir,visible,hidden] of [[a,owned,other],[b,other,owned]]){
    const native=client(dir);clients.push(native);
    assert.ok((await native.rpc('initialize',{clientInfo:{name:'codex-tui',version:'0.169.0'}})).result);
    const params={limit:100,modelProviders:[],sourceKinds:['cli'],currentAccountOnly:true};
    const listed=await native.rpc('thread/list',params);assert.ok(listed.result,JSON.stringify(listed.error));
    assert.ok(listed.result.data.some(x=>x.id===visible.id),'Native picker must see its own account-scoped thread');
    assert.ok(!listed.result.data.some(x=>x.id===hidden.id),'Native picker must hide another ChatGPT account\'s scoped thread');
    assert.ok(listed.result.data.some(x=>x.id===legacy.id),'Legacy unscoped history remains discoverable');
    const unfiltered=await native.rpc('thread/list',{...params,currentAccountOnly:false});
    assert.ok(unfiltered.result?.data.some(x=>x.id===hidden.id),'History exists on disk even when native account filtering hides it');
    const request=pickerRequest(['-c','features.cli_resume_account_check=true','-c','cli_auth_credentials_store="file"','-c','chatgpt_base_url="http://127.0.0.1:9"','resume','--all']);
    const discovery=historyClient(request,{binary:process.env.CX_NATIVE_CODEX||'codex',env:{...clean,HOME:dir,CODEX_HOME:dir,CODEX_SQLITE_HOME:path.join(temp,'sqlite'),HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost'}});
    try{
      await discovery.rpc('initialize',{clientInfo:{name:'cx-history-picker',version:'1'}});
      discovery.notify('initialized');
      const page=await discovery.rpc('thread/list',{limit:20,currentAccountOnly:false,modelProviders:[],archived:false});
      assert.ok(page.data.some(row=>row.id===hidden.id),'The production history client must discover the shared conversation');
    }finally{await discovery.close();}
    let page;
    const selected=await chooseHistory(pickerRequest(['resume','--all']),{client:{rpc:async(method,query)=>{page=(await native.rpc(method,query)).result;return page;}},ask:async()=>String(page.data.findIndex(row=>row.id===hidden.id)+1),write:()=>{}});
    assert.equal(selected,hidden.id,'The cx picker must discover another account\'s session through the supported listing API');
    const denied=await native.rpc('thread/resume',{threadId:hidden.id,excludeTurns:true});
    assert.match(denied.error?.message??'',/different ChatGPT account or workspace/);
    await native.close();
  }
  for(const fixture of [owned,other,legacy])assert.deepEqual(JSON.parse(fs.readFileSync(fixture.filename,'utf8').split('\n')[0]),fixture.metadata,'Creator attribution must remain unchanged');
  console.log('PASS Codex subscription policy: native picker scopes history by identity; enabled ownership checks reject cross-account resume.');
  console.log('PASS cx shared discovery finds other-account sessions; native ownership checks still decide whether continuation is allowed.');
}finally{await Promise.all(clients.map(c=>c.close()));fs.rmSync(temp,{recursive:true,force:true});}
