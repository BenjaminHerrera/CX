#!/usr/bin/env node
// Check the canonical handbook and render a GitHub wiki without network access.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repository='https://github.com/BenjaminHerrera/CX';
const pages=[
  ['Home','docs/README.md','Start Here'],
  ['Getting Started','docs/GETTING-STARTED.md','User Guides'],
  ['Installation','docs/INSTALL.md','User Guides'],
  ['Sessions','docs/SESSIONS.md','User Guides'],
  ['Workspaces and Environments','docs/WORKSPACES.md','User Guides'],
  ['SSH and Remote Files','docs/SSH.md','User Guides'],
  ['Watch for Changes','docs/WATCH.md','User Guides'],
  ['Slurm Setup','docs/SLURM.md','User Guides'],
  ['Import Native Sessions','docs/IMPORTING.md','User Guides'],
  ['Upgrade and Back Up','docs/UPGRADING.md','User Guides'],
  ['Troubleshooting','docs/TROUBLESHOOTING.md','User Guides'],
  ['Accounts and History','docs/ACCOUNTS.md','Reference'],
  ['Command Reference','docs/USAGE.md','Reference'],
  ['Architecture','docs/ARCHITECTURE.md','Reference'],
  ['Support','SUPPORT.md','Reference'],
  ['Contributing','CONTRIBUTING.md','Maintainer Guides'],
  ['Development','docs/DEVELOPMENT.md','Maintainer Guides'],
  ['Maintenance','docs/MAINTAINING.md','Maintainer Guides'],
  ['GitHub Maintenance','docs/GITHUB.md','Maintainer Guides'],
  ['V2 Integration History','docs/V2.md','Integration Records'],
  ['CX2 Validation','docs/CX2-VALIDATION.md','Integration Records'],
  ['CX7 Validation','docs/CX7-VALIDATION.md','Integration Records'],
  ['Security','SECURITY.md','Project Policies'],
  ['Code of Conduct','CODE_OF_CONDUCT.md','Project Policies'],
].map(([title,file,group])=>({title,file,group,slug:title.replaceAll(' ','-')}));
const byFile=new Map(pages.map(page=>[page.file,page]));
const link=/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g;
function prose(text,transform){
  let fence;
  return text.split('\n').map(line=>{
    const marker=line.match(/^\s*(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence=null;return line;}
    return fence?line:transform(line);
  }).join('\n');
}
function localTarget(file,url){
  if(/^[a-z][a-z\d+.-]*:/i.test(url)||url.startsWith('//'))return null;
  const [name,...fragment]=url.split('#');
  return {file:name?path.posix.normalize(path.posix.join(path.posix.dirname(file),decodeURIComponent(name))):file,fragment:decodeURIComponent(fragment.join('#'))};
}
const anchorCache=new Map();
function anchors(file){
  if(anchorCache.has(file))return anchorCache.get(file);
  const found=new Set(),counts=new Map(),text=fs.readFileSync(path.join(root,file),'utf8');
  prose(text,line=>{
    const heading=line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if(heading){
      const base=heading[1].replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/<[^>]+>/g,'').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu,'').replaceAll(' ','-');
      const count=counts.get(base)||0;counts.set(base,count+1);found.add(base+(count?'-'+count:''));
    }
    for(const item of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g))found.add(item[1]);
    return line;
  });
  anchorCache.set(file,found);return found;
}
function check(){
  const files=[...fs.readdirSync(root).filter(name=>name.endsWith('.md')),...fs.readdirSync(path.join(root,'docs'),{recursive:true}).filter(name=>name.endsWith('.md')).map(name=>'docs/'+name)];
  const failures=[];let links=0;
  for(const page of pages)if(!fs.existsSync(path.join(root,page.file)))failures.push('Missing wiki source: '+page.file);
  for(const file of files)prose(fs.readFileSync(path.join(root,file),'utf8'),line=>{
    for(const item of line.matchAll(link)){
      const target=localTarget(file,item[2]);if(!target)continue;links++;
      const absolute=path.resolve(root,target.file);
      if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))failures.push(`${file}: missing target ${item[2]}`);
      else if(target.fragment&&target.file.endsWith('.md')&&!anchors(target.file).has(target.fragment))failures.push(`${file}: missing anchor ${item[2]}`);
    }
    return line;
  });
  if(failures.length)throw new Error(failures.join('\n'));
  console.log(`Checked ${files.length} Markdown documents and ${links} local links/anchors.`);
}
function wiki(output,ref){
  const relative=path.relative(root,output);
  if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&relative!=='dist'&&!relative.startsWith('dist'+path.sep)))throw new Error('Generate into dist/ or a directory outside the source tree.');
  if(!/^[a-zA-Z\d._/-]+$/.test(ref)||ref.includes('..'))throw new Error('Invalid source ref.');
  const encodedRef=ref.split('/').map(encodeURIComponent).join('/');
  fs.mkdirSync(output,{recursive:true});
  for(const page of pages){
    const text=prose(fs.readFileSync(path.join(root,page.file),'utf8'),line=>line.replace(link,(all,start,url,end)=>{
      const target=localTarget(page.file,url);if(!target)return all;
      const mapped=byFile.get(target.file);
      const destination=mapped?`${repository}/wiki/${mapped.slug}`:`${repository}/blob/${encodedRef}/${target.file.split('/').map(encodeURIComponent).join('/')}`;
      return start+destination+(target.fragment?'#'+target.fragment:'')+end;
    }));
    fs.writeFileSync(path.join(output,page.title+'.md'),`<!-- Generated from ${page.file}; edit the repository source. -->\n\n`+text);
  }
  const sidebar=['[CX User Handbook]('+repository+'/wiki/Home)'];
  for(const group of [...new Set(pages.map(page=>page.group))]){
    sidebar.push('\n**'+group+'**\n');
    for(const page of pages.filter(page=>page.group===group))sidebar.push(`- [${page.title}](${repository}/wiki/${page.slug})`);
  }
  fs.writeFileSync(path.join(output,'_Sidebar.md'),sidebar.join('\n')+'\n');
  fs.writeFileSync(path.join(output,'_Footer.md'),`Generated from the [repository handbook](${repository}/tree/${encodedRef}/docs). Submit documentation changes through a repository pull request. [Report a problem](${repository}/issues/new/choose).\n`);
  console.log(`Generated ${pages.length} wiki pages plus sidebar/footer in ${output} (source ref: ${ref}).`);
}
try{
  const {values}=parseArgs({options:{check:{type:'boolean'},'wiki-dir':{type:'string'},ref:{type:'string',default:'main'},help:{type:'boolean',short:'h'}}});
  if(values.help||(!values.check&&!values['wiki-dir']))console.log('Usage: node scripts/docs.mjs --check\n       node scripts/docs.mjs --wiki-dir dist/wiki [--ref main]\n\nChecks local Markdown links/anchors. Builds wiki Markdown only; never publishes.');
  else{check();if(values['wiki-dir'])wiki(path.resolve(values['wiki-dir']),values.ref);}
}catch(error){console.error('docs: '+error.message);process.exitCode=1;}
