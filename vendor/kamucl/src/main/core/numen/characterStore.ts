import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { CharacterBinding, CharacterCard, CharacterDocument, CharacterSummary, CharacterInput } from '../../../shared/characterCard'
import { normalizeCharacter, pngChunks } from './characterCodec'
import { normalizeAppearance } from './appearance'
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function avatarBytes(avatar:string):Buffer {
  if(typeof avatar!=='string'||!avatar.startsWith('data:image/png;base64,')||avatar.length>3*1024*1024)throw new Error('头像必须是 PNG 图片（最大 2 MiB）')
  const bytes=Buffer.from(avatar.slice(22),'base64');pngChunks(bytes);return bytes
}
/** Reads the preceding development format once as plain text; no legacy prompt logic is executed. */
function readDocument(stored:Record<string,any>):CharacterDocument {
  if(typeof stored.name==='string'&&typeof stored.text==='string')return normalizeCharacter(stored)
  const data=stored.document?.data
  if(!data||typeof data.name!=='string')throw new Error('角色卡文件格式无效')
  const native=data.extensions?.['nomadcraft/harness']?.persona
  return normalizeCharacter({name:data.name,text:typeof native==='string'?native:typeof data.system_prompt==='string'&&data.system_prompt.trim()?data.system_prompt:data.description??''})
}
export class CharacterStore {
  constructor(readonly root:string){fs.mkdirSync(root,{recursive:true})}
  private file(id:string):string{if(!ID.test(id))throw new Error('角色卡 ID 无效');return path.join(this.root,id+'.json')}
  private atomic(file:string,value:unknown):void{const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file)}
  get(id:string):CharacterCard {
    const file=this.file(id);if(fs.statSync(file).size>5*1024*1024)throw new Error('角色卡文件过大')
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));if(stored.id!==id)throw new Error('角色卡 ID 不匹配')
    const document=readDocument(stored);if(stored.avatar)avatarBytes(stored.avatar)
    return {id,...document,avatar:stored.avatar||undefined,appearance:normalizeAppearance(stored.appearance),createdAt:stored.createdAt,updatedAt:stored.updatedAt}
  }
  list():CharacterSummary[]{return fs.readdirSync(this.root).filter(name=>ID.test(name.slice(0,-5))&&name.endsWith('.json')).map(name=>{const card=this.get(name.slice(0,-5));return{id:card.id,name:card.name,excerpt:card.text.slice(0,180),avatar:card.avatar,appearance:card.appearance,updatedAt:card.updatedAt}}).sort((a,b)=>b.updatedAt-a.updatedAt)}
  save(input:CharacterInput):CharacterCard {
    const document=normalizeCharacter(input),old=input.id?this.get(input.id):undefined
    const avatar=input.avatar===undefined?old?.avatar:input.avatar||undefined;if(avatar)avatarBytes(avatar)
    const appearance=normalizeAppearance(input.appearance===undefined?old?.appearance:input.appearance)
    const card:CharacterCard={id:old?.id??crypto.randomUUID(),...document,avatar,appearance,createdAt:old?.createdAt??Date.now(),updatedAt:Date.now()}
    this.atomic(this.file(card.id),card);return card
  }
  import(input:CharacterInput):CharacterCard{return this.save(input)}
  duplicate(id:string):CharacterCard{const card=this.get(id);return this.save({name:card.name+' 副本',text:card.text,avatar:card.avatar,appearance:card.appearance})}
  delete(id:string):void{const file=this.file(id);const bindings=this.bindings();for(const[key,value]of Object.entries(bindings))if(value.cardId===id)delete bindings[key];this.atomic(path.join(this.root,'bindings.json'),bindings);fs.unlinkSync(file)}
  private bindings():Record<string,CharacterBinding>{const file=path.join(this.root,'bindings.json');if(!fs.existsSync(file))return{};const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('角色绑定记录无效');return value}
  binding(key:string):CharacterBinding|undefined{const stored=this.bindings()[key];return stored?{cardId:stored.cardId}:undefined}
  bind(key:string,input:CharacterBinding|undefined):void{if(!/^[a-f0-9]{64}$/.test(key))throw new Error('同伴绑定标识无效');const bindings=this.bindings();if(input){this.get(input.cardId);bindings[key]={cardId:input.cardId}}else delete bindings[key];this.atomic(path.join(this.root,'bindings.json'),bindings)}
}
