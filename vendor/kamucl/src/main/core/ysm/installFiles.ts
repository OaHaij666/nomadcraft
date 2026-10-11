import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { modelPath,type YsmFiles } from './archive'
/** Preflight every file before writing; never follow a model path outside the game directory. */
export async function writeYsmFiles(gameDir:string,files:YsmFiles):Promise<number>{
  const root=path.resolve(gameDir),rootStat=fs.lstatSync(root)
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('游戏目录不是普通目录')
  const writes:Array<{file:string;bytes:Buffer}>=[]
  for(const[name,data]of Object.entries(files)){
    const relative='config/yes_steve_model/custom/'+modelPath(name)
    let file=root
    for(const part of relative.split('/')){file=path.join(file,part);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new Error('模型目录不能使用符号链接：'+name)}
    const bytes=Buffer.from(data)
    if(fs.existsSync(file)){
      if(!fs.lstatSync(file).isFile()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==crypto.createHash('sha256').update(bytes).digest('hex'))throw new Error('实例里有同名但不同内容的 YSM 模型，请先处理冲突：'+name)
    }else writes.push({file,bytes})
  }
  const created:string[]=[]
  try{for(const item of writes){fs.mkdirSync(path.dirname(item.file),{recursive:true});fs.writeFileSync(item.file,item.bytes,{flag:'wx'});created.push(item.file)}}
  catch(error){for(const file of created){try{fs.unlinkSync(file)}catch{}}throw error}
  return writes.length
}
