import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { ensureCloudClientNetwork } from '../src/main/core/cloudClientNetwork'
import network from '../bridge/client-network.json'
const artifact=network.forge1201,profile={mcVersion:'1.20.1',loader:'forge'}
const digest=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex')
async function fixture(run:(directory:string,bundle:string)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-network-'));const directory=path.join(root,'game'),bundle=path.join(root,'bundle');
 try{await fs.mkdir(path.join(directory,'mods'),{recursive:true});await fs.mkdir(bundle);await fs.copyFile(path.resolve('out/main',artifact.file),path.join(bundle,artifact.file));await run(directory,bundle)}finally{await fs.rm(root,{recursive:true,force:true})}
}
test('cloud Forge installs the genuine client dependency offline and is idempotent even after rename',()=>fixture(async(directory,bundledDirectory)=>{
 let checked=0;const runtime={bundledDirectory,assertIdle:async()=>{checked++}};
 await ensureCloudClientNetwork(directory,profile,undefined,runtime);const file=path.join(directory,'mods',artifact.file);
 assert.equal(digest(await fs.readFile(file)),artifact.sha256);await fs.rename(file,path.join(directory,'mods/renamed.jar'));
 await ensureCloudClientNetwork(directory,profile,undefined,runtime);assert.deepEqual(await fs.readdir(path.join(directory,'mods')),['renamed.jar']);assert(checked>=3)
}))
test('client dependency preserves unknown same-name files and rejects damaged bundled bytes',()=>fixture(async(directory,bundledDirectory)=>{
 const runtime={bundledDirectory,assertIdle:async()=>{}},file=path.join(directory,'mods',artifact.file);
 await fs.writeFile(file,'personal file');await assert.rejects(ensureCloudClientNetwork(directory,profile,undefined,runtime),/同名文件/);assert.equal(await fs.readFile(file,'utf8'),'personal file');
 await fs.unlink(file);await fs.writeFile(path.join(bundledDirectory,artifact.file),'bad');await assert.rejects(ensureCloudClientNetwork(directory,profile,undefined,runtime),/校验失败/);assert.deepEqual(await fs.readdir(path.join(directory,'mods')),[])
}))
test('client dependency refuses a running instance and cancelled job; other loaders are untouched',()=>fixture(async(directory,bundledDirectory)=>{
 await assert.rejects(ensureCloudClientNetwork(directory,profile,undefined,{bundledDirectory,assertIdle:async()=>{throw Error('running')}}),/running/);
 const controller=new AbortController();controller.abort();await assert.rejects(ensureCloudClientNetwork(directory,profile,controller.signal,{bundledDirectory,assertIdle:async()=>{}}));
 for(const target of [{mcVersion:'1.21.1',loader:'neoforge'},{mcVersion:'1.20.1',loader:'fabric'}])await ensureCloudClientNetwork(directory,target,undefined,{bundledDirectory,assertIdle:async()=>{throw Error('must not inspect unrelated instance')}});
 assert.deepEqual(await fs.readdir(path.join(directory,'mods')),[])
}))
