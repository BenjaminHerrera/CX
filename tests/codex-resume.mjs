#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pickerRequest,chooseHistory,listParams} from '../container/cx-codex-resume.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(root,'.cx-test-resume-'));
const bin=path.join(temp,'bin'),log=path.join(temp,'calls');fs.mkdirSync(bin);
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
let checks=0;
async function check(name,test){await test();console.log(`ok ${++checks} - ${name}`);}
try{
await check('bare resume is recognized without stealing native commands or option values',()=>{
  assert.deepEqual(pickerRequest(['--profile','work','resume','--all','--include-non-interactive'],temp),{resumeIndex:2,config:['--profile','work'],cwd:undefined,noninteractive:true});
  assert.equal(pickerRequest(['resume','--cd','main'],temp).cwd,path.join(temp,'main'));
  assert.deepEqual(pickerRequest(['resume','-c','features.cli_resume_account_check=true'],temp).config,['-c','features.cli_resume_account_check=true']);
  for(const args of [['exec','resume'],['--model','resume'],['resume',first],['resume','--last'],['resume','--help'],['--remote','unix://socket','resume'],['resume','--','literal'],['--','resume'],['resume','--unknown']])assert.equal(pickerRequest(args,temp),null,JSON.stringify(args));
});
await check('shared listing is bounded, respects directory/source filters and does not alter policy',()=>{
  const request=pickerRequest(['resume'],temp),params=listParams(request,null);
  assert.equal(params.currentAccountOnly,false);assert.equal(params.limit,20);assert.equal(params.cwd,temp);assert.equal(params.archived,false);
  assert.equal(Object.hasOwn(params,'sourceKinds'),false);
  assert.ok(listParams({...request,noninteractive:true}).sourceKinds.includes('exec'));
});
await check('empty or failed history listings stop before selecting a conversation',async()=>{
  for(const client of [{rpc:async()=>({data:[]})},{rpc:async()=>({})},{rpc:async()=>{throw new Error('native listing denied');}}]){
    await assert.rejects(chooseHistory(pickerRequest(['resume']),{client,ask:async()=>{throw new Error('must not prompt');},write:()=>{}}),/No matching|invalid history|native listing denied/);
  }
});
await check('picker supports pagination, cancellation, EOF and safe terminal labels',async()=>{
  const pages={start:{data:[{id:first,preview:'first\x1b[31m\nspoof'}],nextCursor:'next'},next:{data:[{id:second,name:'second'}],nextCursor:null}};
  const choices=['invalid','n','p','n','1'];let output='';
  const result=await chooseHistory(pickerRequest(['resume','--all']),{client:{rpc:async(method,params)=>{assert.equal(method,'thread/list');return pages[params.cursor||'start'];}},ask:async()=>choices.shift(),write:text=>output+=text});
  assert.equal(result,second);assert.equal(output.includes('\x1b'),false);assert.ok(output.includes('Choose a listed number'));
  for(const answer of ['q',null])assert.equal(await chooseHistory(pickerRequest(['resume']),{client:{rpc:async()=>pages.start},ask:async()=>answer,write:()=>{}}),null);
});
fs.writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');const args=process.argv.slice(2);
fs.appendFileSync(process.env.CX_TEST_LOG,JSON.stringify({args})+'\\n');
if(args.includes('app-server')){
 const input=readline.createInterface({input:process.stdin});input.on('line',line=>{
  const message=JSON.parse(line);fs.appendFileSync(process.env.CX_TEST_LOG,JSON.stringify(message)+'\\n');
  if(message.method==='thread/list'&&process.env.CX_TEST_BAD_HISTORY){console.log(JSON.stringify({id:message.id,error:{message:'native listing denied'}}));return;}
  if(message.id){const result=message.method==='thread/list'?{data:[{id:'${first}',preview:'conversation from the first account'}],nextCursor:null}:{};console.log(JSON.stringify({id:message.id,result}));}
 });
}else if(args.includes('--version'))console.log('codex-cli 0.169.0');
else {console.log('NATIVE_RESUME '+JSON.stringify(args));process.exitCode=Number(process.env.CX_TEST_EXIT||0);}
`,{mode:0o755});
const runner=path.join(temp,'runner');fs.writeFileSync(runner,'#!/bin/bash\nexec bash "$CX_TEST_ADAPTER" --cx-session -c features.cli_resume_account_check=true resume --all\n',{mode:0o755});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CX_')&&!/^(CODEX|OPENAI|CLAUDE|ANTHROPIC)/.test(k)));
Object.assign(env,{PATH:bin+path.delimiter+process.env.PATH,CX_MANAGED_HISTORY:'1',CODEX_SQLITE_HOME:path.join(temp,'sqlite'),CX_AGENT:'codex',CX_TEST_LOG:log,CX_TEST_RUNNER:runner,CX_TEST_ADAPTER:path.join(root,'container/cx-agent')});
const pty=(input,extra={})=>spawnSync('script',['-q','-e','-c','exec "$CX_TEST_RUNNER"','/dev/null'],{env:{...env,...extra},input,encoding:'utf8',timeout:15000});
await check('selected ID is passed to native Codex with original checks and exit status',()=>{
  const result=pty('1\n',{CX_TEST_EXIT:'27'});assert.equal(result.status,27,result.stdout+result.stderr);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),native=calls.findLast(x=>x.args?.includes('--sandbox'));
  assert.deepEqual(native.args,['--sandbox','danger-full-access','-c','features.cli_resume_account_check=true','resume',first,'--all']);
  assert.equal(calls.find(x=>x.method==='initialize').params.clientInfo.name,'cx-history-picker');
  assert.equal(calls.some(x=>x.method==='thread/resume'),false,'The listing client must never perform the resume');
  assert.equal(calls.find(x=>x.method==='thread/list').params.currentAccountOnly,false);
});
await check('cancellation never starts native resume',()=>{
  fs.writeFileSync(log,'');const result=pty('q\n');assert.equal(result.status,130,result.stdout+result.stderr);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args?.includes('--sandbox')),false);
});
await check('failed listing reports the error and never invokes native resume',()=>{
  fs.writeFileSync(log,'');const result=pty('1\n',{CX_TEST_BAD_HISTORY:'1'});assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stdout,/native listing denied/);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args?.includes('--sandbox')),false);
});
await check('noninteractive resume and explicit IDs retain native behavior',()=>{
  fs.writeFileSync(log,'');
  let result=spawnSync('bash',[env.CX_TEST_ADAPTER,'--cx-session','resume'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  let calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args?.includes('app-server')),false);
  fs.writeFileSync(log,'');fs.writeFileSync(runner,'#!/bin/bash\nexec bash "$CX_TEST_ADAPTER" --cx-session resume '+first+'\n',{mode:0o755});
  result=pty('');assert.equal(result.status,0,result.stdout+result.stderr);
  calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args?.includes('app-server')),false);
  assert.deepEqual(calls.find(x=>x.args?.includes('--sandbox')).args,['--sandbox','danger-full-access','resume',first]);
});
console.log(`\n${checks} shared Codex resume checks passed.`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
