const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const failures=[];
for(const item of fs.readdirSync(root)){if(/\.(?:log|png|jpe?g)$/i.test(item)||['launchers','%PROGRAMDATA%','NVIDIA Corporation'].includes(item))failures.push('Root artifact: '+item);}
for(const dir of ['apps','crates','vendor/kamucl','vendor/mcsmanager','vendor/minecraft-numen','scripts/dev','scripts/verify','docs/product','docs/design','docs/implementation','docs/research','docs/archive','docs/proofs','docs/screenshots'])if(!fs.existsSync(path.join(root,dir)))failures.push('Missing directory: '+dir);
if(fs.existsSync(path.join(root,'.nomad')))for(const item of fs.readdirSync(path.join(root,'.nomad')))if(!['runtime','cache','diagnostics','backups'].includes(item))failures.push('Unclassified local file: .nomad/'+item);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.md')?[path.join(dir,e.name)]:[])}
for(const file of [path.join(root,'README.md'),path.join(root,'CONTRIBUTING.md'),...walk(path.join(root,'docs')),...walk(path.join(root,'scripts'))]){
 const source=fs.readFileSync(file,'utf8');
 for(const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
  let ref=match[1].trim().replace(/^<|>$/g,'');
  if(/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(ref))continue;
  ref=ref.split(/[?#]/)[0];if(!ref)continue;
  if(!fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(ref))))failures.push(path.relative(root,file)+': broken link '+ref);
 }
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1}else console.log('PASS workspace layout and local documentation links');
