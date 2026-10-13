// Plain-Node integration fixtures need Electron app paths; never use the real user's launcher data.
const Module=require('node:module'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nc-electron-test-'));
// A stale host JAVA_HOME must not route fixture compilation to a missing SDK.
if(process.platform==='win32' && !fs.existsSync(path.join(process.env.JAVA_HOME||'', 'bin/javac.exe'))){
 const base=path.join(process.env.ProgramFiles||'C:/Program Files','Eclipse Adoptium');
 if(fs.existsSync(base)){const jdks=fs.readdirSync(base).filter(name=>fs.existsSync(path.join(base,name,'bin/javac.exe'))).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));if(jdks[0])process.env.JAVA_HOME=path.join(base,jdks[0]);}
}
const original=Module._load;
const electron={app:{isPackaged:false,getPath:name=>{const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});return dir;},getVersion:()=> '0.1.0',getName:()=> 'KAMUCL NC',getAppPath:()=>process.cwd()},safeStorage:{isEncryptionAvailable:()=>false}};
Module._load=function(request,parent,isMain){if(request==='electron' && !parent?.filename?.includes(path.sep+'tests'+path.sep))return electron;return original.call(this,request,parent,isMain)};
process.once('exit',()=>{if(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('nc-electron-test-'))fs.rmSync(root,{recursive:true,force:true});});
