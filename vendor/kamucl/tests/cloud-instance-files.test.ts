import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { cloudInstanceFiles } from '../src/main/core/cloudInstanceFiles'
async function fixture(run:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-cloud-files-'));try{await run(root)}finally{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true})}}
test('actual cloud inventory hashes files before constructing managed/seed metadata',()=>fixture(async root=>{
 for(const dir of ['mods','config','shaderpacks'])await fs.mkdir(path.join(root,dir));
 await fs.writeFile(path.join(root,'mods/core.jar'),'core-mod-bytes');await fs.writeFile(path.join(root,'config/runtime.sqlite'),'personal-runtime-data');await fs.writeFile(path.join(root,'shaderpacks/personal.zip'),'visual-bytes');
 const files=await cloudInstanceFiles(root),mod=files.find(f=>f.path==='mods/core.jar')!;assert(mod);assert.equal(mod.sha256,crypto.createHash('sha256').update('core-mod-bytes').digest('hex'));assert.equal(mod.size,14);assert.equal(mod.ownership,'managed');assert.equal(mod.side,'both');
 assert.equal(files.find(f=>f.path==='config/runtime.sqlite')?.ownership,'seed');assert.equal(files.find(f=>f.path==='shaderpacks/personal.zip')?.side,'client');assert.equal(await fs.readFile(path.join(root,'config/runtime.sqlite'),'utf8'),'personal-runtime-data');
}))
test('cloud inventory refuses redirected managed roots',()=>fixture(async root=>{
 const external=path.join(root,'outside');await fs.mkdir(external);await fs.writeFile(path.join(external,'must-not-read.jar'),'private');await fs.symlink(external,path.join(root,'mods'),process.platform==='win32'?'junction':'dir');await assert.rejects(cloudInstanceFiles(root));
}))
