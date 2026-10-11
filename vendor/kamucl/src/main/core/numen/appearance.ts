import type { CharacterAppearance, CharacterSkin, CharacterYsm, YsmOptions } from '../../../shared/characterCard'
import { pngChunks } from './characterCodec'

export function skinBytes(png:string):Buffer {
  if(typeof png!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)||png.length>2*1024*1024)throw new Error('皮肤须为 PNG 图片，最大 1 MiB')
  const bytes=Buffer.from(png.slice(22),'base64')
  if(bytes.length>1024*1024)throw new Error('皮肤图片最大 1 MiB')
  const chunks=pngChunks(bytes),header=chunks[0].data
  if(header.readUInt32BE(0)!==64||![32,64].includes(header.readUInt32BE(4)))throw new Error('皮肤尺寸须为 64 × 64 或 64 × 32')
  if(!chunks.some(chunk=>chunk.type==='IDAT'))throw new Error('皮肤 PNG 缺少像素数据')
  return bytes
}
export function normalizeYsm(input:unknown):CharacterYsm {
  const value=input as CharacterYsm
  if(!value||typeof value.model!=='string'||!value.model.trim()||value.model.length>512||/[\x00-\x1f\x7f]/.test(value.model))throw new Error('请填写有效的 YSM 模型 ID（最多 512 字）')
  if(value.texture!==undefined&&(typeof value.texture!=='string'||value.texture.length>256||/[\x00-\x1f\x7f]/.test(value.texture)))throw new Error('YSM 贴图 ID 无效')
  if(value.assetId!==undefined&&(typeof value.assetId!=='string'||!/^[a-f0-9]{64}$/.test(value.assetId)))throw new Error('本地 YSM 模型标识无效')
  return {model:value.model,...(value.assetId?{assetId:value.assetId}:{}), ...(value.texture?{texture:value.texture}:{})}
}
export function normalizeAppearance(input:unknown):CharacterAppearance|undefined {
  if(input===null||input===undefined)return undefined
  if(typeof input!=='object'||Array.isArray(input))throw new Error('角色外观格式无效')
  const value=input as CharacterAppearance,result:CharacterAppearance={}
  if(value.skin){skinBytes(value.skin.png);if(!['classic','slim'].includes(value.skin.variant))throw new Error('请选择标准或纤细手臂');result.skin={png:value.skin.png,variant:value.skin.variant} as CharacterSkin}
  if(value.ysm)result.ysm=normalizeYsm(value.ysm)
  return Object.keys(result).length?result:undefined
}
/** Decimal UTF-8 escapes work in Lua and cannot terminate a string literal. */
export function luaString(value:string):string {return '"'+[...Buffer.from(value,'utf8')].map(byte=>'\\'+String(byte).padStart(3,'0')).join('')+'"'}
/** Print each ID as hex to avoid Lua receipt quoting and table truncation. A final count detects a truncated stdout. */
export function ysmScript(look?:CharacterYsm):string {
  const chosen=look?normalizeYsm(look):undefined
  return (chosen?'ysm.model.switch('+luaString(chosen.model)+(chosen.texture?', {texture = '+luaString(chosen.texture)+'}':'')+')\n':'')+[
    'local o = ysm.model.options()',
    'local function out(k, v) local h = ""; for i = 1, #v do h = h .. string.format("%02x", string.byte(v, i)) end; print("NCYSM|" .. k .. "|" .. h .. "|") end',
    'out("C", o.current_model or "")', 'out("S", o.current_texture or "")',
    'for _, v in ipairs(o.models) do out("M", v) end',
    'for _, v in ipairs(o.textures) do out("T", v) end',
    'print("NCYSM_END|" .. #o.models .. "|" .. #o.textures .. "|")'
  ].join('\n')
}
export function parseYsmOptions(text:string):YsmOptions {
  const result:YsmOptions={models:[],textures:[]},end=text.match(/NCYSM_END\|(\d+)\|(\d+)\|/)
  let current=false,texture=false
  for(const match of text.matchAll(/NCYSM\|([CSMT])\|([a-f0-9]*)\|/g)){
    if(match[2].length%2||match[2].length>4096)throw new Error('YSM 外观返回值无效')
    const value=Buffer.from(match[2],'hex').toString('utf8')
    if(match[1]==='C'){result.currentModel=value||undefined;current=true}
    else if(match[1]==='S'){result.currentTexture=value||undefined;texture=true}
    else result[match[1]==='M'?'models':'textures'].push(value)
  }
  if(!end||!current||!texture||result.models.length!==Number(end[1])||result.textures.length!==Number(end[2]))throw new Error('未收到完整的 YSM 模型清单，请检查 Numen / YSM 联动版本或游戏日志')
  return result
}
