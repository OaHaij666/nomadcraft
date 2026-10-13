const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const files={
 '1.20.1-fabric':{file:'FabricProxy-Lite-2.6.0.jar',cache:'fabricproxy-1.20.1.jar',url:'https://cdn.modrinth.com/data/8dI2tmqs/versions/XJmDAnj5/FabricProxy-Lite-2.6.0.jar',sha256:'d4719179353d790453061c14b4148994ff431ac57a126555b3009ce9a748d6c7'},
 '1.21.1-fabric':{file:'FabricProxy-Lite-2.10.1.jar',cache:'fabricproxy-1.21.1.jar',url:'https://cdn.modrinth.com/data/8dI2tmqs/versions/KqB3UA0q/FabricProxy-Lite-2.10.1.jar',sha256:'36737b62c7a5dfb679ac3fac6a7db10f9a423317fba19574bc4d472b4711c742'},
 fabricApi121:{file:'fabric-api-0.116.7+1.21.1.jar',cache:'fabric-api-0.116.7-1.21.1.jar',url:'https://cdn.modrinth.com/data/P7dR8mSH/versions/m6zu1K31/fabric-api-0.116.7%2B1.21.1.jar',sha256:'08018cc48c97415a38016a00dbd5a2c7a460ba6b7a051690a8cb3dbb5e8482a4'},
 forge:{file:'proxy-compatible-forge-1.3.1.jar',cache:'proxy-compatible-forge-1.3.1.jar',url:'https://github.com/adde0109/Proxy-Compatible-Forge/releases/download/v1.3.1/proxy-compatible-forge-1.3.1.jar',sha256:'ea541aff6276970d98506965c8e71bd4ad7329452f631b2f45eb08edea425271'}
};
function forwardingConfig(loader,secret){
 if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw Error('Invalid gateway forwarding secret');
 if(loader==='fabric')return{file:'config/FabricProxy-Lite.toml',text:'hackOnlineMode = true\nhackEarlySend = true\nhackMessageChain = true\nsecret = '+JSON.stringify(secret)+'\n'};
 if(['forge','neoforge'].includes(loader))return{file:'config/proxy-compatible-forge.toml',text:'[forwarding]\nenabled = true\nmode = "MODERN"\nsecret = '+JSON.stringify(secret)+'\n[crossStitch]\nenabled = true\n'};
 throw Error('Backend requires a validated modern-forwarding adapter');
}
async function prepareBackend(directory,{minecraft,loader,secret},{cache=path.join(__dirname,'dist/dependencies'),fetchArtifact}={}){
 if(!['1.20.1-fabric','1.20.1-forge','1.21.1-fabric','1.21.1-neoforge'].includes(minecraft+'-'+loader))throw Error('Unsupported backend forwarding target');
 const config=forwardingConfig(loader,secret),artifact=loader==='fabric'?files[minecraft+'-'+loader]:files.forge,root=path.resolve(directory);
 // Only a stopped, freshly extracted executor workspace may call this function.
 let bytes;const cached=path.join(cache,artifact.cache);if(fs.existsSync(cached))bytes=await fsp.readFile(cached);else if(fetchArtifact)bytes=await fetchArtifact(artifact);else{const response=await fetch(artifact.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Forwarding adapter download failed: '+response.status);bytes=Buffer.from(await response.arrayBuffer());}
 if(bytes.length>8*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('Forwarding adapter checksum mismatch');
 for(const top of['mods','config']){const dir=path.join(root,top);const stat=await fsp.lstat(dir).catch(()=>undefined);if(stat?.isSymbolicLink()||stat&&!stat.isDirectory())throw Error('Unsafe backend '+top+' directory');await fsp.mkdir(dir,{recursive:true});}
 const mod=path.join(root,'mods',artifact.file),dest=path.join(root,config.file);
 for(const file of[mod,dest])if((await fsp.lstat(file).catch(()=>undefined))?.isSymbolicLink())throw Error('Unsafe forwarding file');
 if(fs.existsSync(mod)&&crypto.createHash('sha256').update(await fsp.readFile(mod)).digest('hex')!==artifact.sha256)throw Error('Existing forwarding adapter conflicts');
 if(fs.existsSync(dest)&&(await fsp.readFile(dest,'utf8'))!==config.text)throw Error('Existing forwarding configuration conflicts');
 await fsp.writeFile(mod,bytes);await fsp.writeFile(dest,config.text,{mode:0o600});return{file:'mods/'+artifact.file,sha256:artifact.sha256,configFile:config.file};
}
module.exports={files,forwardingConfig,prepareBackend};
