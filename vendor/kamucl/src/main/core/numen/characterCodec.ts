import { crc32 } from 'node:zlib'
import type { CharacterDocument } from '../../../shared/characterCard'
const SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10])
export function normalizeCharacter(input:unknown):CharacterDocument {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('角色卡必须包含名称和人设正文')
  const value=input as Record<string,unknown>
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>120)throw new Error('角色名称须为 1–120 字')
  if(typeof value.text!=='string'||value.text.length>100000)throw new Error('人设正文须为文字，最多 100000 字')
  return {name:value.name.trim(),text:value.text}
}
interface PngChunk { type:string;data:Buffer;raw:Buffer }
export function pngChunks(bytes:Buffer):PngChunk[]{
  if(bytes.length>16*1024*1024||bytes.length<33||!bytes.subarray(0,8).equals(SIGNATURE))throw new Error('请选择有效的 PNG 图片（最大 16 MiB）')
  const chunks:PngChunk[]=[];let offset=8,ended=false
  while(offset<bytes.length){if(offset+12>bytes.length)throw new Error('PNG 数据截断');const length=bytes.readUInt32BE(offset);if(length>16*1024*1024||offset+length+12>bytes.length)throw new Error('PNG 区块长度无效');const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);if(crc32(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))throw new Error('PNG 校验失败，图片可能已损坏');chunks.push({type,data,raw:bytes.subarray(offset,offset+length+12)});offset+=length+12;if(type==='IEND'){ended=true;break}}
  if(!ended||offset!==bytes.length||chunks[0]?.type!=='IHDR'||chunks[0].data.length!==13)throw new Error('PNG 结构无效')
  const width=chunks[0].data.readUInt32BE(0),height=chunks[0].data.readUInt32BE(4)
  if(width<1||height<1||width>8192||height>8192||width*height>16777216)throw new Error('角色头像尺寸过大')
  return chunks
}
