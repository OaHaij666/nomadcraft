// Prepare a separate forwarded copy; never overwrite the verified Mojang source jar.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const hash=async(file,algorithm='sha256')=>{const digest=crypto.createHash(algorithm);for await(const chunk of require('node:fs').createReadStream(file))digest.update(chunk);return digest.digest('hex')};
async function patchVanilla({source,destination,java,patcher,manifest,minecraft,expectedSha1}) {
 if(!['1.20.1','1.21.1'].includes(minecraft))throw Error('Unsupported vanilla forwarding version');
 if(!/^[a-f0-9]{40}$/.test(expectedSha1||''))throw Error('Official vanilla source checksum required');
 if(path.resolve(source)===path.resolve(destination))throw Error('Forwarded output must not replace the official source');
 for(const file of[source,patcher]){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unsafe vanilla forwarding input');}
 if(await hash(source,'sha1')!==expectedSha1)throw Error('Official vanilla source checksum mismatch');
 const record=JSON.parse(await fs.readFile(manifest,'utf8'));
 if(!/^[a-f0-9]{64}$/.test(record.sha256||'')||await hash(patcher)!==record.sha256)throw Error('VanillaCord patcher checksum mismatch');
 if(record.javaSourceModified!==false||!record.sources?.some(s=>s.name==='VanillaCord'&&s.commit==='8d4493ac76052ff6ba68ce498f2bd5d7f5dae859'))throw Error('Unrecognized VanillaCord build provenance');
 await fs.mkdir(path.dirname(destination),{recursive:true});const temporary=destination+'.'+crypto.randomUUID()+'.part';
 try{
 await new Promise((resolve,reject)=>{let output='';const child=spawn(java,['-cp',patcher,'vanillacord.Patcher',source,temporary],{windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(Error('VanillaCord patch preparation timed out'));},120000);timer.unref();for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>output=(output+bytes).slice(-8000));child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('VanillaCord patch preparation failed: '+output.slice(-2000)))});});
 const stat=await fs.lstat(temporary);if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw Error('VanillaCord produced invalid output');const sha256=await hash(temporary);await fs.rename(temporary,destination);return {minecraft,sourceSha1:expectedSha1,sha256,size:stat.size,patcherSha256:record.sha256};
 }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error});}
}
module.exports={patchVanilla};
