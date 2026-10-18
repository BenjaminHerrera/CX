#!/usr/bin/env node
// Behavioral checks with isolated host state. No network or real Docker required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const temp = fs.mkdtempSync(path.join(root, '.cx-test-'));
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`ok ${checks} - ${name}`); }
const fixture = path.join(temp, 'bundle with spaces');
const mockBin = path.join(temp, 'mock-bin');
const project = path.join(temp, 'project with spaces');
const home = path.join(temp, 'home');
const log = path.join(temp, 'docker.jsonl');
for (const dir of [fixture, mockBin, project, home]) fs.mkdirSync(dir, {recursive:true});
for (const file of ['bin','container','config','docs','scripts','tests','VERSION','README.md','CHANGELOG.md','.gitignore','cx','install.sh','uninstall.sh']) {
  fs.cpSync(path.join(root,file),path.join(fixture,file),{recursive:true});
}
const env = {...process.env};
for (const key of Object.keys(env)) if (key.startsWith('CX_')) delete env[key];
Object.assign(env, { HOME:home, PATH:`${mockBin}:${process.env.PATH}`, MOCK_DOCKER_LOG:log });
fs.writeFileSync(path.join(mockBin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args)+'\\n');
if (process.env.MOCK_DOCKER_FAIL && args[0] === process.env.MOCK_DOCKER_FAIL) process.exit(37);
if (args[0] === 'image' && process.env.MOCK_IMAGE_MISSING === '1') process.exit(1);
` ,{mode:0o755});
function run(command,args=[],options={}) {
  const result = spawnSync(command,args,{cwd:project,env:{...env,...options.env},encoding:'utf8',...options});
  if (options.ok !== false) assert.equal(result.status,0,`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function bash(file,args=[],options={}) { return run('bash',[path.join(fixture,file),...args],options); }
function calls() { return fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function reset() { fs.writeFileSync(log,''); }
function lastRun() { return calls().filter(x=>x[0]==='run').at(-1); }
function contains(args, fragment) { assert.ok(args.some(x=>x.includes(fragment)), `missing ${fragment} in ${JSON.stringify(args)}`); }
try {
check('all distributed shell scripts parse',()=>{
  for (const file of ['cx','bin/cx','install.sh','uninstall.sh','scripts/package.sh','scripts/verify-docker.sh','container/cx-entrypoint','container/cx-env']) run('bash',['-n',path.join(fixture,file)]);
});
check('help and version do not invoke Docker or create portable data',()=>{
  assert.match(bash('cx',['--help']).stdout,/Usage:/);
  assert.match(bash('cx',['--version']).stdout,new RegExp(`cx ${version.replaceAll('.', '\\.')}`));
  assert.equal(calls().length,0);
  assert.equal(fs.existsSync(path.join(fixture,'data')),false);
});
check('doctor reports prerequisites without creating state',()=>{
  assert.match(bash('cx',['--doctor']).stdout,/OK: image exists/);
  assert.equal(fs.existsSync(path.join(fixture,'data')),false);
});
check('build uses bundle-relative context and requested version',()=>{
  reset(); bash('cx',['--build'],{env:{...env,CX_CODEX_VERSION:'test-version'}});
  const build = calls().find(x=>x[0]==='build');
  contains(build,'CODEX_VERSION=test-version');
  assert.equal(build.at(-1),path.join(fixture,'container'));
  assert.equal(build.includes('--no-cache'),false);
  reset(); bash('cx',['--rebuild']); assert.ok(calls().find(x=>x[0]==='build').includes('--no-cache'));
});
check('portable run mounts private data, writable project, and system configuration',()=>{
  reset(); bash('cx',[project,'exec','a task with spaces']);
  const args=lastRun();
  contains(args,`src=${project},dst=/workspace`);
  contains(args,`src=${fixture}/data/codex,dst=/codex-home`);
  contains(args,`src=${fixture}/config,dst=/etc/codex,readonly`);
  contains(args,`src=${fixture}/data/environments/project_with_spaces-`);
  assert.equal(args.includes('-t'),false);
  assert.ok(args.includes('-i'));
  assert.equal(args.at(-1),'a task with spaces');
});
check('piped commands preserve arguments and return container failures',()=>{
  const result=bash('cx',[project,'exec','-'],{input:'example task',ok:false,env:{...env,MOCK_DOCKER_FAIL:'run'}});
  assert.equal(result.status,37);
});
check('extra directories and literal ignore paths produce expected mounts',()=>{
  const extra=path.join(temp,'shared files'); fs.mkdirSync(extra);
  fs.writeFileSync(path.join(project,'.codexignore'),'.env\nsecrets\n');
  fs.writeFileSync(path.join(project,'.env'),'test-value');
  fs.mkdirSync(path.join(project,'secrets'));
  reset(); bash('cx',[project,'--add-dir',extra]);
  const args=lastRun(); contains(args,`src=${extra},dst=/cx-external/shared_files`);
  contains(args,'src=/dev/null,dst=/workspace/.env,readonly');
  contains(args,'dst=/workspace/secrets,tmpfs-mode=0555,readonly');
  assert.ok(args.includes('/cx-external/shared_files'));
});
check('invalid ignore traversal fails before running Docker',()=>{
  fs.writeFileSync(path.join(project,'.codexignore'),'../outside\n');
  reset(); const result=bash('cx',[project],{ok:false});
  assert.equal(result.status,1); assert.match(result.stderr,/Invalid path/);
  assert.equal(lastRun(),undefined);
  fs.unlinkSync(path.join(project,'.codexignore'));
});
check('root, credential overlap, and invalid environment names are rejected',()=>{
  for (const [args,options] of [
    [['/'],{}], [['--shell'],{cwd:'/'}],
    [[fixture],{}],
    [[project],{env:{...env,CX_ENV_NAME:'../bad'}}],
    [[project],{env:{...env,CX_ENV_HOME:project}}],
  ]) { reset(); assert.notEqual(bash('cx',args,{...options,ok:false}).status,0); assert.equal(lastRun(),undefined); }
});
check('portable folder can be relocated and invoked through a symlink',()=>{
  const moved=path.join(temp,'moved bundle'); fs.renameSync(fixture,moved);
  const link=path.join(temp,'portable-link'); fs.symlinkSync(path.join(moved,'cx'),link);
  reset(); run('bash',[link,project]); contains(lastRun(),`src=${moved}/data/codex`);
  fs.renameSync(moved,fixture);
});
check('installer refuses unrelated existing launchers',()=>{
  const prefix=path.join(temp,'collision'); fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
  const launcher=path.join(prefix,'bin/cx'); fs.writeFileSync(launcher,'original');
  assert.notEqual(bash('install.sh',['--no-build','--prefix',prefix],{ok:false}).status,0);
  assert.equal(fs.readFileSync(launcher,'utf8'),'original');
});
const prefix=path.join(temp,'install prefix');
check('installation works without Docker and uses installed data defaults',()=>{
  reset(); bash('install.sh',['--no-build','--prefix',prefix]); assert.equal(calls().length,0);
  const launcher=path.join(prefix,'bin/cx'); assert.ok(fs.lstatSync(launcher).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(prefix,'share/cx/program/scripts')),false);
  assert.equal(fs.existsSync(path.join(prefix,'share/cx/program/tests')),false);
  run('bash',[launcher,project]); const args=lastRun();
  contains(args,`src=${home}/.codex,dst=/codex-home`);
  contains(args,`src=${home}/.local/share/cx/environments/`);
  contains(args,`src=${prefix}/share/cx/config,dst=/etc/codex,readonly`);
});
check('managed upgrades preserve configuration and create a program backup',()=>{
  const config=path.join(prefix,'share/cx/config/config.toml'); fs.appendFileSync(config,'\n# local customization\n');
  bash('install.sh',['--no-build','--prefix',prefix]);
  assert.match(fs.readFileSync(config,'utf8'),/local customization/);
  assert.ok(fs.readdirSync(path.join(prefix,'share/cx')).some(x=>x.startsWith('backup-')));
  run('bash',[path.join(prefix,'bin/cx'),'--version']);
});
check('failed default build leaves the existing installation in place',()=>{
  const config=path.join(prefix,'share/cx/config/config.toml');
  const result=bash('install.sh',['--prefix',prefix],{ok:false,env:{...env,MOCK_DOCKER_FAIL:'build'}});
  assert.equal(result.status,37); assert.match(fs.readFileSync(config,'utf8'),/local customization/);
  run('bash',[path.join(prefix,'bin/cx'),'--version']);
});
check('uninstall removes managed program and keeps configuration and data',()=>{
  bash('uninstall.sh',['--prefix',prefix]);
  assert.equal(fs.existsSync(path.join(prefix,'bin/cx')),false);
  assert.equal(fs.existsSync(path.join(prefix,'share/cx/program')),false);
  assert.ok(fs.existsSync(path.join(prefix,'share/cx/config/config.toml')));
  assert.ok(fs.existsSync(path.join(home,'.codex')));
});
check('cx-env selects environments, rejects invalid names, and preserves session overrides',()=>{
  const store=path.join(temp,'environments'); fs.mkdirSync(path.join(store,'envs/tools/conda-meta'),{recursive:true});
  const opts={env:{...env,MAMBA_ROOT_PREFIX:store}};
  assert.equal(bash('container/cx-env',['active'],opts).stdout.trim(),'default');
  bash('container/cx-env',['use','tools'],opts);
  assert.equal(bash('container/cx-env',['active'],opts).stdout.trim(),'tools');
  assert.equal(bash('container/cx-env',['path'],opts).stdout.trim(),`${store}/envs/tools`);
  const override={env:{...opts.env,CX_ENV_NAME:'other',CX_ENV_SESSION_OVERRIDE:'true'}};
  assert.equal(bash('container/cx-env',['active'],override).stdout.trim(),'other');
  assert.notEqual(bash('container/cx-env',['path','../bad'],{...opts,ok:false}).status,0);
});
check('clean releases exclude runtime data and run after extraction',()=>{
  const output=path.join(temp,'releases'); bash('scripts/package.sh',['--output',output]);
  run('sha256sum',['-c','SHA256SUMS'],{cwd:output});
  for (const edition of ['install','portable']) {
    const archive=path.join(output,`cx-${version}-${edition}.tar.gz`);
    const listing=run('tar',['-tzf',archive]).stdout;
    assert.equal(listing.includes('/data/'),false); assert.equal(listing.includes('/environments/'),false);
    const extract=path.join(temp,`extract-${edition}`); fs.mkdirSync(extract);
    run('tar',['-xzf',archive,'-C',extract]);
    const bundle=path.join(extract,`cx-${version}-${edition}`);
    run('sha256sum',['-c','MANIFEST.sha256'],{cwd:bundle});
    assert.match(run('bash',[path.join(bundle,'cx'),'--version']).stdout,new RegExp(version.replaceAll('.', '\\.')));
    if (edition === 'install') run('bash',[path.join(bundle,'install.sh'),'--no-build','--prefix',path.join(temp,'archive install')]);
    else { reset(); run('bash',[path.join(bundle,'cx'),project]); contains(lastRun(),`src=${bundle}/data/codex`); }
  }
});
console.log(`\n${checks} offline checks passed. Docker build/runtime and live login were not tested.`);
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
