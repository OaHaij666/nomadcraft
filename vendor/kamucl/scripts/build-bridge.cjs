// Build shared bridge code for Fabric, Forge 1.20.1 and NeoForge 1.21.1.
// Loader annotations are compile-only stubs; runtime definitions come from the actual loader.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),bridge=path.join(root,'bridge');
const dependencies=[
 {file:'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',base:'https://maven.fabricmc.net/',hash:'93044e4dd46de5d8136701292f05e868da096d2c9fddb4793e4fdbcc63efc695'},
 {file:'com/google/code/gson/gson/2.14.0/gson-2.14.0.jar',base:'https://repo.maven.apache.org/maven2/',hash:'2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f'}];
const targets=[{loader:'fabric',java:17,file:'kamucl-bridge-1.0.1.jar'},{loader:'forge',minecraft:'1.20.1',packFormat:15,java:17,file:'kamucl-bridge-forge-1.20.1-1.0.1.jar'},{loader:'neoforge',minecraft:'1.21.1',packFormat:34,java:21,file:'kamucl-bridge-neoforge-1.21.1-1.0.1.jar'}];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
const scan=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?scan(path.join(dir,entry.name)):entry.name.endsWith('.java')?[path.join(dir,entry.name)]:[]);
async function main(){
 const network=require('../bridge/client-network.json').forge1201;
 const networkCache=path.join(bridge,'.cache',network.file);fs.mkdirSync(path.dirname(networkCache),{recursive:true});
 if(!fs.existsSync(networkCache)||hash(networkCache)!==network.sha256){
  const response=await fetch(network.url);if(!response.ok)throw Error('Client network dependency HTTP '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(bytes).digest('hex')!==network.sha256||crypto.createHash('sha512').update(bytes).digest('hex')!==network.sha512)throw Error('Client network dependency checksum mismatch');fs.writeFileSync(networkCache,bytes);
 }
 fs.mkdirSync(path.join(bridge,'dist'),{recursive:true});fs.copyFileSync(networkCache,path.join(bridge,'dist',network.file));
 const cp=[];
 for(const dep of dependencies){const file=path.join(bridge,'.cache',path.basename(dep.file));fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)||hash(file)!==dep.hash){
  const local=process.env.KAMUCL_BUILD_LIBS&&path.join(process.env.KAMUCL_BUILD_LIBS,dep.file);
  if(local&&fs.existsSync(local)&&hash(local)===dep.hash)fs.copyFileSync(local,file);
  else{const response=await fetch(dep.base+dep.file);if(!response.ok)throw Error('Build dependency HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(bytes).digest('hex')!==dep.hash)throw Error('Build dependency checksum mismatch');fs.writeFileSync(file,bytes)}
 }cp.push(file)}
 const tool=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':'')):process.platform==='win32'?path.join('C:/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot/bin',name+'.exe'):name;
 const artifacts=[];
 for(const target of targets){
  const workspace=path.join(bridge,'build',target.loader+'-'+process.pid),classes=path.join(workspace,'classes'),source=path.join(workspace,'src');
  if(!workspace.startsWith(bridge+path.sep))throw Error('Invalid bridge build directory');fs.rmSync(workspace,{recursive:true,force:true});fs.mkdirSync(classes,{recursive:true});fs.cpSync(path.join(bridge,'src'),source,{recursive:true});
  const compile=scan(path.join(source,'cn'));
  if(target.loader!=='fabric'){
   const annotation=target.loader==='forge'?'net.minecraftforge.fml.common':'net.neoforged.fml.common';
   const stub=path.join(workspace,'stubs',...annotation.split('.'),'Mod.java');write(stub,'package '+annotation+'; import java.lang.annotation.*; @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE) public @interface Mod { String value(); }');compile.push(stub);
   write(path.join(source,'cn/kamucl/bridge/KamuclBridgeMod.java'),'package cn.kamucl.bridge; @'+annotation+'.Mod("kamucl_bridge") public final class KamuclBridgeMod { public KamuclBridgeMod(){BridgeBootstrap.initialize();} }');
  }
  execFileSync(tool('javac'),['-proc:none','-encoding','UTF-8','--release',String(target.java),'-cp',cp.join(path.delimiter),'-d',classes,...compile],{stdio:'inherit',windowsHide:true});
  if(target.loader==='fabric'){fs.copyFileSync(path.join(bridge,'src/fabric.mod.json'),path.join(classes,'fabric.mod.json'));write(path.join(classes,'bridge-platform.properties'),'loader=fabric\n')}
  else{
   fs.rmSync(path.join(classes,'net'),{recursive:true,force:true});fs.copyFileSync(path.join(bridge,'profiles',target.minecraft+'-'+target.loader+'.properties'),path.join(classes,'bridge-platform.properties'));
   const neo=target.loader==='neoforge';const dependency=(id,range)=>'\n[[dependencies.kamucl_bridge]]\nmodId="'+id+'"\n'+(neo?'type="required"':'mandatory=true')+'\nversionRange="'+range+'"\nordering="NONE"\nside="BOTH"\n';
   const metadata='modLoader="javafml"\nloaderVersion="'+(neo?'[4,)':'[47,)')+'"\nlicense="MIT"\n[[mods]]\nmodId="kamucl_bridge"\nversion="1.0.1"\ndisplayName="KAMUCL NC Player Bridge"\ndisplayTest="IGNORE_SERVER_VERSION"\n'+dependency('minecraft','['+target.minecraft+']')+dependency(target.loader,neo?'[21.1,)':'[47,)');
   write(path.join(classes,'META-INF',neo?'neoforge.mods.toml':'mods.toml'),metadata);
   // Forge scans each mod as a resource pack, including bridges with no textures.
   write(path.join(classes,'pack.mcmeta'),JSON.stringify({pack:{pack_format:target.packFormat,description:'KAMUCL NC Player Bridge'}})+'\n');
  }
  const manifest=path.join(workspace,'MANIFEST.MF');write(manifest,'Manifest-Version: 1.0\nCreated-By: NomadCraft\n\n');const output=path.join(bridge,'dist',target.file);fs.mkdirSync(path.dirname(output),{recursive:true});
  execFileSync(tool('jar'),['--create','--file',output,'--manifest',manifest,'--date','2020-01-01T00:00:00Z','-C',classes,'.'],{stdio:'inherit',windowsHide:true});artifacts.push({...target,sha256:hash(output)});console.log('Built bridge: '+target.file);
 }
 write(path.join(bridge,'dist/manifest.json'),JSON.stringify({schema:1,version:'1.0.1',artifacts},null,2)+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1});
