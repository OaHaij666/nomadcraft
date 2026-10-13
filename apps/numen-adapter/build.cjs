const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=__dirname,cache=path.join(root,'.cache'),classes=path.join(root,'build/classes');
const libs=[
 ['fabric-loader.jar','https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar','93044e4dd46de5d8136701292f05e868da096d2c9fddb4793e4fdbcc63efc695'],
 ['gson.jar','https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar','2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f'],
 ['mixin.jar','https://maven.fabricmc.net/net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar','1f0ae44db7295f8626f33b1dc0ad7f043d8954a8d6847247875fcc5dfcecc934'],
 ['brigadier.jar','https://libraries.minecraft.net/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar','c8ee4136e474ac7723ca2b432ec8d1a2bc88ef7d1ec57c314ba9e33cdc83dd75']];

const targets=[
 {minecraft:'1.20.1',loader:'fabric',java:17},
 {minecraft:'1.20.1',loader:'forge',java:17},
 {minecraft:'1.21.1',loader:'fabric',java:21},
 {minecraft:'1.21.1',loader:'neoforge',java:21}
];
function scan(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?scan(path.join(dir,entry.name)):entry.name.endsWith('.java')?[path.join(dir,entry.name)]:[]);}
function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
async function main(){
 fs.mkdirSync(cache,{recursive:true});
 for(const [name,url,hash]of libs){const file=path.join(cache,name);if(!fs.existsSync(file)){const response=await fetch(url);if(!response.ok)throw Error('Dependency HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('Checksum mismatch');fs.writeFileSync(file,bytes);}if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('Cache checksum mismatch');}
 const tool=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':'')):process.platform==='win32'?path.join('C:/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot/bin',name+'.exe'):name;
 const artifacts=[];
 for(const target of targets){
  const id=target.minecraft+'-'+target.loader,workspace=path.join(root,'build',id+'-'+process.pid),source=path.join(workspace,'src'),outputClasses=path.join(workspace,'classes');
  if(!workspace.startsWith(root+path.sep))throw Error('Invalid build directory');fs.rmSync(workspace,{recursive:true,force:true});fs.mkdirSync(outputClasses,{recursive:true});fs.cpSync(path.join(root,'src'),source,{recursive:true});
  let properties='loader='+target.loader+'\n';
  if(target.loader!=='fabric')properties+=fs.readFileSync(path.join(root,'profiles',id+'.properties'),'utf8').replaceAll('\r\n','\n');
  const prop=Object.fromEntries(properties.split(/\r?\n/).filter(line=>line.includes('=')).map(line=>line.split('=')));
  if(target.loader!=='fabric'){
   const annotation=target.loader==='forge'?'net.minecraftforge.fml.common':'net.neoforged.fml.common';
   write(path.join(workspace,'stubs',...annotation.split('.'),'Mod.java'),`package ${annotation}; import java.lang.annotation.*; @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE) public @interface Mod { String value(); }`);
   write(path.join(source,'com/nomadcraft/numen/LoaderEntry.java'),`package com.nomadcraft.numen; @${annotation}.Mod("nomad_numen_adapter") public final class LoaderEntry { public LoaderEntry(){} }`);
   for(const file of scan(path.join(source,'com/nomadcraft/numen/mixin'))){let code=fs.readFileSync(file,'utf8');code=code.replace(/net\/minecraft\/class_\d+/g,name=>{const mapped=prop['class.'+name.replaceAll('/','.')];if(!mapped)throw Error('Unmapped descriptor '+name);return mapped.replaceAll('.','/');}).replaceAll('method_29741',prop['method.method_29741']);fs.writeFileSync(file,code);}
  }
  const compile=scan(source).concat(target.loader==='fabric'?[]:scan(path.join(workspace,'stubs')));
  execFileSync(tool('javac'),['-proc:none','-encoding','UTF-8','--release',String(target.java),'-cp',libs.map(([name])=>path.join(cache,name)).join(path.delimiter),'-d',outputClasses,...compile],{stdio:'inherit',windowsHide:true});
  // Stub annotations are compile-only. Real definitions are supplied by each loader.
  if(target.loader!=='fabric')fs.rmSync(path.join(outputClasses,'net'),{recursive:true,force:true});
  const mixins=JSON.parse(fs.readFileSync(path.join(root,'src/nomad-numen.mixins.json'),'utf8'));mixins.compatibilityLevel='JAVA_'+target.java;
  write(path.join(outputClasses,'nomad-numen.mixins.json'),JSON.stringify(mixins,null,2));write(path.join(outputClasses,'nomad-platform.properties'),properties);
  if(target.loader==='fabric'){
   const metadata=JSON.parse(fs.readFileSync(path.join(root,'src/fabric.mod.json'),'utf8'));metadata.depends.minecraft=target.minecraft;metadata.depends.java='>='+target.java;metadata.depends.fabricloader=target.minecraft==='1.20.1'?'>=0.15.11':'>=0.18.1';
   write(path.join(outputClasses,'fabric.mod.json'),JSON.stringify(metadata,null,2));
  }else{
   const neo=target.loader==='neoforge';
   const dep=(mod,range)=>`\n[[dependencies.nomad_numen_adapter]]\nmodId="${mod}"\n${neo?'type="required"':'mandatory=true'}\nversionRange="${range}"\nordering="AFTER"\nside="BOTH"\n`;
   let metadata=`modLoader="javafml"\nloaderVersion="${neo?'[4,)':'[47,)'}"\nlicense="MIT"\n[[mods]]\nmodId="nomad_numen_adapter"\nversion="0.1.0"\ndisplayName="NomadCraft Numen Adapter"\n`;
   metadata+=dep('minecraft','['+target.minecraft+']')+dep('numen_api','[0.1.4.1]')+dep(target.loader,neo?'[21.1,)':'[47,)');
   if(neo)metadata+='\n[[mixins]]\nconfig="nomad-numen.mixins.json"\n';
   write(path.join(outputClasses,'META-INF',neo?'neoforge.mods.toml':'mods.toml'),metadata);
   write(path.join(outputClasses,'pack.mcmeta'),JSON.stringify({pack:{pack_format:target.minecraft==='1.20.1'?15:34,description:'NomadCraft Numen Adapter'}})+'\n');
  }
  const manifest=path.join(workspace,'MANIFEST.MF');write(manifest,'Manifest-Version: 1.0\nCreated-By: NomadCraft\nMixinConfigs: nomad-numen.mixins.json\n\n');
  const name='nomad-numen-adapter-'+target.loader+'-'+target.minecraft+'.jar',output=path.join(root,'dist',name);fs.mkdirSync(path.dirname(output),{recursive:true});
  execFileSync(tool('jar'),['--create','--file',output,'--manifest',manifest,'--date','2020-01-01T00:00:00Z','-C',outputClasses,'.'],{stdio:'inherit',windowsHide:true});
  artifacts.push({...target,id,file:name,numen:'0.1.4.1',sha256:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')});console.log('Built '+name);
 }
 write(path.join(root,'dist/manifest.json'),JSON.stringify({schema:1,artifacts},null,2)+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
