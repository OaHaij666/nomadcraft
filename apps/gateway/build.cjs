const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {artifacts}=require('./prepare.cjs');
const backendFiles=[...new Map(Object.values(require('./backend.cjs').files).map(file=>[file.cache,file])).values()];
const dependenciesList=artifacts.concat(backendFiles);
const root=__dirname,workspace=path.join(root,'build',String(process.pid)),classes=path.join(workspace,'classes'),dependencies=process.argv[2]||path.join(root,'.cache');
async function main(){
 fs.mkdirSync(dependencies,{recursive:true});
 for(const artifact of dependenciesList){const file=path.join(dependencies,artifact.cache),shared=path.resolve(root,'../../.nomad/cache/gateway',artifact.cache);if(!fs.existsSync(file)){if(fs.existsSync(shared))fs.copyFileSync(shared,file);else{const response=await fetch(artifact.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Gateway dependency HTTP '+response.status);fs.writeFileSync(file,Buffer.from(await response.arrayBuffer()));}}if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==artifact.sha256)throw Error('Gateway dependency checksum mismatch: '+artifact.cache);}
 if(!workspace.startsWith(root+path.sep))throw Error('Invalid build workspace');fs.rmSync(workspace,{recursive:true,force:true});fs.mkdirSync(classes,{recursive:true});
 const tools=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin'):process.platform==='win32'?'C:/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot/bin':'';const tool=name=>tools?path.join(tools,name+(process.platform==='win32'?'.exe':'')):name;
 const cp=['velocity-3.3.0-436.jar','limboapi-1.1.26.jar'].map(name=>path.join(dependencies,name)).join(path.delimiter);
 execFileSync(tool('javac'),['-proc:none','-encoding','UTF-8','--release','21','-cp',cp,'-d',classes,...fs.readdirSync(path.join(root,'src/com/nomadcraft/gateway')).filter(file=>file.endsWith('.java')).map(file=>path.join(root,'src/com/nomadcraft/gateway',file))],{stdio:'inherit',windowsHide:true});
 fs.writeFileSync(path.join(classes,'velocity-plugin.json'),JSON.stringify({id:'nomad-gateway',name:'NomadCraft Gateway',version:'0.1.0',main:'com.nomadcraft.gateway.NomadGateway',authors:['NomadCraft'],dependencies:[{id:'limboapi',optional:false},{id:'reconnect-velocity',optional:false}]}));
 const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});execFileSync(tool('jar'),['--create','--file',path.join(dist,'nomad-gateway.jar'),'--date','2020-01-01T00:00:00Z','-C',classes,'.'],{stdio:'inherit',windowsHide:true});
 fs.mkdirSync(path.join(dist,'dependencies'),{recursive:true});for(const artifact of dependenciesList)fs.copyFileSync(path.join(dependencies,artifact.cache),path.join(dist,'dependencies',artifact.cache));
 for(const file of ['vanillacord-2.0.jar','vanillacord-2.0.jar.json']){const source=path.join(dependencies,file);if(!fs.existsSync(source))throw Error('Build original VanillaCord using scripts/dev/build-vanillacord.cjs before packaging the gateway');fs.copyFileSync(source,path.join(dist,'dependencies',file));}
 fs.copyFileSync(path.join(root,'licenses/vanillacord-MPL-2.0.txt'),path.join(dist,'dependencies/vanillacord-MPL-2.0.txt'));
 const vanillaRecord=JSON.parse(fs.readFileSync(path.join(dist,'dependencies/vanillacord-2.0.jar.json'),'utf8'));if(crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,'dependencies/vanillacord-2.0.jar'))).digest('hex')!==vanillaRecord.sha256)throw Error('VanillaCord build checksum mismatch');
 fs.writeFileSync(path.join(dist,'manifest.json'),JSON.stringify({schema:1,java:21,artifacts,lifecycle:{file:'nomad-gateway.jar',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,'nomad-gateway.jar'))).digest('hex')}},null,2));console.log('Built and packaged NomadCraft gateway');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
