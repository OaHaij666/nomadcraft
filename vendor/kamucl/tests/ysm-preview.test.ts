import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeYsmFiles } from '../src/main/core/ysm/installFiles'
import { createRequire } from 'node:module'
import { crc32,deflateSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { modelPath,prepareYsmPreview,unzipYsm,type YsmFiles } from '../src/main/core/ysm/archive'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { normalizeYsm } from '../src/main/core/numen/appearance'
import { parse,compileScript,compileTemplate } from '@vue/compiler-sfc'
function chunk(type:string,data:Buffer){const length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([length,Buffer.from(type),data,crc])}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(64*(64*4+1)))),chunk('IEND',Buffer.alloc(0))])}
const geometry={format_version:'1.12.0','minecraft:geometry':[{description:{identifier:'geometry.test',texture_width:64,texture_height:64},bones:[{name:'body',pivot:[0,8,0],cubes:[{origin:[-4,0,-2],size:[8,16,4],uv:[0,0]}]},{name:'arm',parent:'body',pivot:[4,14,0],cubes:[{origin:[4,2,-2],size:[4,12,4],uv:[32,16]}]}]}]}
const animation={format_version:'1.8.0',animations:{'animation.test.walk':{loop:true,animation_length:1,bones:{arm:{rotation:{'0':[0,0,0],'.5':[45,0,0],'1':[0,0,0]}}}}}}
function resources():YsmFiles{return{'model/ysm.json':Buffer.from(JSON.stringify({metadata:{name:'测试模型'},properties:{preview_animation:'walk'},files:{player:{model:{main:'models/main.json'},texture:['textures/test.png'],animation:{main:'animations/main.animation.json'}}}})),'model/models/main.json':Buffer.from(JSON.stringify(geometry)),'model/textures/test.png':png(),'model/animations/main.animation.json':Buffer.from(JSON.stringify(animation))}}
test('YSM manifest resolves nested package assets and keeps texture and real animation metadata',()=>{const preview=prepareYsmPreview(resources(),{id:'a'.repeat(64),modelId:'test',createdAt:1});assert.equal(preview.asset.name,'测试模型');assert.deepEqual(preview.asset.textures,['test']);assert.equal(preview.asset.animationCount,1);assert.equal(preview.defaultAnimation,'walk');assert.equal(JSON.parse(preview.geometry)['minecraft:geometry'][0].bones.length,2)})
test('YSM rejects path traversal, missing textures and cyclic bone graphs',()=>{for(const name of ['../escape','/absolute','C:/drive','a/../b','a//b'])assert.throws(()=>modelPath(name));const noTexture=resources();delete noTexture['model/textures/test.png'];assert.throws(()=>prepareYsmPreview(noTexture,{id:'a'.repeat(64),modelId:'test',createdAt:1}));const circular=resources(),g=structuredClone(geometry);g['minecraft:geometry'][0].bones[0].parent='arm';circular['model/models/main.json']=Buffer.from(JSON.stringify(g));assert.throws(()=>prepareYsmPreview(circular,{id:'a'.repeat(64),modelId:'test',createdAt:1}),/循环/)})
test('YSM ZIP reader preserves resources and rejects traversal before extraction',()=>{const zip=new AdmZip();for(const[name,data]of Object.entries(resources()))zip.addFile(name,Buffer.from(data));assert.equal(Object.keys(unzipYsm(zip.toBuffer())).length,4);const entry=zip.getEntries()[0];entry.entryName='../escape';assert.throws(()=>unzipYsm(zip.toBuffer()),/路径/)})
test('role appearance preserves a local YSM reference independently of server model id',()=>{assert.deepEqual(normalizeYsm({model:'real/server-model.ysm',assetId:'a'.repeat(64),texture:'test'}),{model:'real/server-model.ysm',assetId:'a'.repeat(64),texture:'test'});assert.throws(()=>normalizeYsm({model:'test',assetId:'../escape'}))})
test('bundled YSMParser WASM initializes locally without network fetches',async()=>{const require=createRequire(import.meta.url),factory=require('../ysm-runtime/YSMParser.cjs'),binary=fs.readFileSync('ysm-runtime/YSMParser.wasm');const module=await factory({wasmBinary:binary,noInitialRun:true,print:()=>{},printErr:()=>{}});assert.equal(typeof module.callMain,'function');module.FS.mkdir('/nomad-test');module.FS.writeFile('/nomad-test/test',new Uint8Array([1,2,3]));assert.deepEqual([...module.FS.readFile('/nomad-test/test')],[1,2,3])})
test('YSM viewer, default settings, role cards and home compile as actual Vue components',()=>{for(const file of ['src/renderer/src/components/YsmViewer3D.vue','src/renderer/src/components/DefaultYsm.vue','src/renderer/src/components/CharacterCards.vue','src/renderer/src/views/HomeView.vue','src/renderer/src/views/KeysView.vue']){const{descriptor,errors}=parse(fs.readFileSync(file,'utf8'));assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'ysm-test'});assert.deepEqual(compileTemplate({source:descriptor.template!.content,filename:file,id:'ysm-test',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])}})

test('model installation preflights all conflicts, preserves local files and remains idempotent',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kamucl-ysm-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('kamucl-ysm-'));fs.rmSync(dir,{recursive:true,force:true})});const files={'test/ysm.json':Buffer.from('manifest'),'test/model.json':Buffer.from('model')};assert.equal(await writeYsmFiles(dir,files),2);assert.equal(await writeYsmFiles(dir,files),0);const existing=path.join(dir,'config/yes_steve_model/custom/test/model.json');fs.writeFileSync(existing,'local');await assert.rejects(writeYsmFiles(dir,{'test/new.json':Buffer.from('new'),...files}),/同名/);assert.equal(fs.readFileSync(existing,'utf8'),'local');assert.equal(fs.existsSync(path.join(dir,'config/yes_steve_model/custom/test/new.json')),false);await assert.rejects(writeYsmFiles(dir,{'../escape':Buffer.from('x')}),/路径/)});


test('YSMViewer bundles the audited engine and original C# payload builder',()=>{
 const provenance=JSON.parse(fs.readFileSync('licenses/ysmviewer/SOURCE.json','utf8'))
 for(const file of provenance.files){const original=fs.readFileSync('licenses/ysmviewer/source/'+path.basename(file.local));assert.equal(crypto.createHash('sha256').update(original).digest('hex'),file.sha256);if(!file.local.endsWith('ysm-three-renderer.js'))assert.deepEqual(fs.readFileSync(file.local),original)}
 const renderer=fs.readFileSync('src/renderer/public/ysmviewer/ysm-three-renderer.js','utf8');assert.ok(renderer.includes('const bonePath = boneObj.uuid'));assert.ok(renderer.includes('scene.updateMatrixWorld(true)'))
})

test('original YSMViewer loader parses an unrelated synthetic ZIP with its own geometry and texture',t=>{
 if(process.platform!=='win32'||process.arch!=='x64'){t.skip('Windows x64 runtime');return}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nc-ysmviewer-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true})})
 const zip=new AdmZip();for(const [name,data] of Object.entries(resources()))zip.addFile(name,Buffer.from(data));zip.writeZip(path.join(dir,'other-model.zip'))
 execFileSync(path.resolve('ysm-runtime/viewer/NomadYsm.exe'),[path.join(dir,'other-model.zip'),path.join(dir,'payload.json')],{windowsHide:true,timeout:15000})
 const payload=JSON.parse(fs.readFileSync(path.join(dir,'payload.json'),'utf8'));assert.equal(payload.engine,'ysmviewer-1');const spec=JSON.parse(payload.spec);const model=spec.models.find((m:any)=>m.defaultVisible);assert.ok(model);assert.equal(model.bones.length,2);assert.equal(model.meshGroups.length,2);assert.equal(payload.textures.length,1);assert.ok(payload.animations.some((text:string)=>Object.hasOwn(JSON.parse(text).animations??{},'animation.test.walk')))
})
