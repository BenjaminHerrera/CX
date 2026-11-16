#!/usr/bin/env node
// Discover shared native history; native Codex owns and authorizes the resume.
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';

const configFlags=new Set(['-c','--config','-p','--profile','--enable','--disable']);
const valueFlags=new Set([...configFlags,'-m','--model','-s','--sandbox','-a','--ask-for-approval','-C','--cd','-i','--image','--add-dir','--local-provider']);
const switches=new Set(['--all','--include-non-interactive','--search','--oss','--no-alt-screen','--no-daemon','--approve-for-me','--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust','--worktree']);
export function pickerRequest(args,cwd=process.cwd()){
  let resumeIndex=-1,all=false,noninteractive=false;const config=[];
  for(let index=0;index<args.length;index++){
    const argument=args[index],equals=argument.indexOf('='),flag=equals>0?argument.slice(0,equals):argument;
    if(valueFlags.has(flag)){
      const value=equals>0?argument.slice(equals+1):args[++index];
      if(value===undefined)return null;
      if(configFlags.has(flag))config.push(flag,value);
      if(flag==='--cd'||flag==='-C')cwd=path.resolve(cwd,value);
      continue;
    }
    if(argument==='resume'&&resumeIndex<0){resumeIndex=index;continue;}
    if(switches.has(argument)){
      if(argument==='--all')all=true;
      if(argument==='--include-non-interactive')noninteractive=true;
      continue;
    }
    // Explicit IDs, --last, help, remote sessions, native -- and unrecognized
    // options retain native behavior. Never reinterpret their positional args.
    return null;
  }
  return resumeIndex<0?null:{resumeIndex,config,cwd:all?undefined:cwd,noninteractive};
}

export function historyClient(request,{binary='codex',env=process.env}={}){
  const child=spawn(binary,[...request.config,'app-server'],{env,stdio:['pipe','pipe','ignore']});
  const pending=new Map();let next=0,buffer='',failure;
  function fail(error){failure=error;for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();}
  child.on('error',()=>fail(new Error('Cannot start the Codex history service; rebuild the image.')));
  child.on('exit',()=>fail(new Error('Codex history service exited before replying.')));
  child.stdin.on('error',()=>fail(new Error('Codex history service disconnected.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();
    if(Buffer.byteLength(buffer)>4*1024*1024){fail(new Error('Codex history response exceeded the output limit.'));child.kill();return;}
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let message;try{message=JSON.parse(line);}catch{fail(new Error('Invalid Codex history response.'));child.kill();return;}
      const item=pending.get(message.id);if(!item)continue;
      pending.delete(message.id);clearTimeout(item.timer);
      if(message.error)item.reject(new Error(message.error.message||'Codex rejected the history request.'));
      else item.resolve(message.result);
    }
  });
  return {
    rpc(method,params){
      if(failure)return Promise.reject(failure);
      return new Promise((resolve,reject)=>{
        const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex history request timed out.'));},15000);
        pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
      });
    },
    notify(method){child.stdin.write(JSON.stringify({method})+'\n');},
    async close(){
      fail(new Error('Codex history service closed.'));
      if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.kill();const timer=setTimeout(()=>child.kill('SIGKILL'),1000);await exited;clearTimeout(timer);
    },
  };
}

export function listParams(request,cursor){
  return {limit:20,cursor,sortKey:'updated_at',modelProviders:[],archived:false,
    currentAccountOnly:false,...(request.cwd?{cwd:request.cwd}:{}),
    ...(request.noninteractive?{sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown']}:{}),
  };
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const display=text=>String(text??'').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,110);
export async function chooseHistory(request,{client,ask,write}={}){
  const cursors=[null];let page=0;
  while(true){
    const result=await client.rpc('thread/list',listParams(request,cursors[page]));
    if(!Array.isArray(result?.data))throw new Error('Codex returned an invalid history page.');
    const rows=result.data.filter(row=>uuid.test(row.id)).slice(0,20);
    if(!rows.length&&page===0)throw new Error('No matching shared conversations. Try resume --all or --include-non-interactive.');
    write('\nShared Codex history\n');
    rows.forEach((row,index)=>write(`${index+1}) ${display(row.name||`Untitled Session [${row.id.slice(0,8)}]`)} [${row.id}]\n`));
    const answer=await ask(`Choose conversation${result.nextCursor?' / n next':''}${page?' / p previous':''} / q cancel: `);
    if(answer===null)return null;
    const choice=answer.trim();
    if(choice.toLowerCase()==='q')return null;
    if(choice.toLowerCase()==='n'&&result.nextCursor){cursors[++page]=result.nextCursor;continue;}
    if(choice.toLowerCase()==='p'&&page){page--;continue;}
    if(/^\d{1,2}$/.test(choice)&&Number(choice)>0&&Number(choice)<=rows.length)return rows[Number(choice)-1].id;
    write('Choose a listed number, page command, or q.\n');
  }
}

async function main(){
  const request=pickerRequest(process.argv.slice(2));
  if(!request){process.exitCode=3;return;}
  const client=historyClient(request);let terminal;
  try{
    // Honest client identity is used only for listing. Resume always runs in
    // the real codex CLI, with the selected credentials and all native checks.
    await client.rpc('initialize',{clientInfo:{name:'cx-history-picker',version:'1'}});
    client.notify('initialized');
    terminal=createInterface({input:process.stdin,output:process.stderr});
    const lines=terminal[Symbol.asyncIterator]();
    terminal.on('SIGINT',()=>terminal.close());
    const id=await chooseHistory(request,{client,ask:async prompt=>{
      process.stderr.write(prompt);
      const answer=await lines.next();
      return answer.done?null:answer.value;
    },write:text=>process.stderr.write(text)});
    if(id===null){process.exitCode=130;return;}
    process.stdout.write(`${request.resumeIndex}:${id}\n`);
  }catch(error){process.stderr.write('cx: '+display(error.message)+'\n');process.exitCode=1;}
  finally{terminal?.close();await client.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
