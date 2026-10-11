import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCharacterYsm,type CharacterYsmRuntime } from '../src/main/core/numen/characterYsm'
import { writeYsmFiles } from '../src/main/core/ysm/installFiles'
import type { CharacterYsm,YsmOptions } from '../src/shared/characterCard'
const look:CharacterYsm={model:'traveler',texture:'red',assetId:'a'.repeat(64)}
const options=(models:string[]=[]):YsmOptions=>({models,textures:[]})
function runtime(overrides:Partial<CharacterYsmRuntime>={}){
 const calls:string[]=[]
 const value:CharacterYsmRuntime={install:async()=>{calls.push('install');return{count:2,modelId:'traveler'}},query:async()=>{calls.push('query');return options(['traveler'])},reload:async()=>{calls.push('reload')},apply:async chosen=>{calls.push('apply');return{...options(['traveler']),currentModel:chosen.model,currentTexture:chosen.texture}},log:()=>{},wait:async()=>{},...overrides};return{value,calls}
}
test('a newly copied role model reloads and becomes visible before appearance is applied',async()=>{
 let visible=false;const r=runtime();r.value.query=async()=>{r.calls.push('query');return options(visible?['traveler']:[])};r.value.reload=async()=>{r.calls.push('reload');visible=true}
 const result=await ensureCharacterYsm(look,r.value);assert.equal(result.currentTexture,'red');assert.deepEqual(r.calls,['install','query','reload','query','apply'])
})
test('an identical installed model is reused without reloading all models',async()=>{const r=runtime({install:async()=>({count:0,modelId:'traveler'})});await ensureCharacterYsm(look,r.value);assert.deepEqual(r.calls,['query','apply'])})
test('a missing model with no independent source is never falsely applied',async()=>{const r=runtime({query:async()=>options()});await assert.rejects(ensureCharacterYsm({model:'traveler'},r.value),/没有关联模型文件/);assert.deepEqual(r.calls,[])})
test('reload permissions failure preserves files but does not apply the look',async()=>{const r=runtime({query:async()=>options(),reload:async()=>{throw new Error('permission denied')}});await assert.rejects(ensureCharacterYsm(look,r.value),/已复制.*重载失败.*permission denied/);assert.deepEqual(r.calls,['install'])})
test('a previous failed reload is retried even when no new files were copied',async()=>{let queried=0,reloaded=false;const r=runtime({install:async()=>({count:0,modelId:'traveler'}),query:async()=>options(reloaded&&++queried>1?['traveler']:[]),reload:async()=>{reloaded=true}});await ensureCharacterYsm(look,r.value);assert.ok(reloaded);assert.ok(queried>=2);assert.deepEqual(r.calls,['apply'])})
test('unrecognized or unauthorized models fail after bounded retries',async()=>{let queries=0;const r=runtime({query:async()=>{queries++;return options()}});await assert.rejects(ensureCharacterYsm(look,r.value),/未识别或未授权/);assert.equal(queries,11);assert.ok(!r.calls.includes('apply'))})
test('model identity or appearance readback mismatch cannot report success',async()=>{const r=runtime({install:async()=>({count:0,modelId:'other'})});await assert.rejects(ensureCharacterYsm(look,r.value),/模型 ID/);assert.deepEqual(r.calls,[]);const mismatch=runtime({apply:async()=>({...options(),currentModel:'other'})});await assert.rejects(ensureCharacterYsm(look,mismatch.value),/未确认/)})
test('a model library can provision two instances without moving its source and protects conflicts',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nc-role-model-'));t.after(()=>{assert.equal(path.dirname(temp),os.tmpdir());fs.rmSync(temp,{recursive:true,force:true})})
 const library=path.join(temp,'library');fs.mkdirSync(library);const original=path.join(library,'source.bin');fs.writeFileSync(original,'independent model')
 const files={'traveler/ysm.json':Buffer.from('manifest'),'traveler/textures/red.png':fs.readFileSync(original)}
 for(const name of ['first','second']){const dir=path.join(temp,name);fs.mkdirSync(dir);assert.equal(await writeYsmFiles(dir,files),2);assert.equal(await writeYsmFiles(dir,files),0)}
 assert.equal(fs.readFileSync(original,'utf8'),'independent model')
 const target=path.join(temp,'first/config/yes_steve_model/custom/traveler/textures/red.png');fs.writeFileSync(target,'different model');let applied=false
 const r=runtime({install:async()=>({count:await writeYsmFiles(path.join(temp,'first'),files),modelId:'traveler'}),apply:async()=>{applied=true;return options()}})
 await assert.rejects(ensureCharacterYsm(look,r.value),/同名但不同内容/);assert.equal(applied,false);assert.equal(fs.readFileSync(target,'utf8'),'different model');assert.equal(fs.readFileSync(original,'utf8'),'independent model')
})
