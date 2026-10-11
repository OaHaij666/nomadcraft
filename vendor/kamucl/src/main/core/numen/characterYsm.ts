import { normalizeYsm } from './appearance'
import type { CharacterYsm,YsmOptions } from '../../../shared/characterCard'
export interface CharacterYsmRuntime {
 install:(assetId:string)=>Promise<{count:number;modelId:string}>
 query:()=>Promise<YsmOptions>
 reload:()=>Promise<void>
 apply:(look:CharacterYsm)=>Promise<YsmOptions>
 log:(message:string)=>void
 wait?:(milliseconds:number)=>Promise<void>
}
/** Original resources stay in the launcher library. A game instance only receives a verified copy. */
export async function ensureCharacterYsm(input:CharacterYsm,runtime:CharacterYsmRuntime):Promise<YsmOptions>{
 const look=normalizeYsm(input)
 if(look.assetId){
  const installed=await runtime.install(look.assetId)
  if(installed.modelId!==look.model)throw new Error('角色卡模型 ID 与独立模型库不一致，请重新选择关联模型：'+installed.modelId)
  runtime.log(installed.count?'已从独立模型库补齐 YSM 资源（'+installed.count+' 个文件）：'+look.model:'实例已有相同 YSM 资源，已校验并复用：'+look.model)
 }
 let options=await runtime.query()
 if(!options.models.includes(look.model)){
  if(!look.assetId)throw new Error('目标游戏未识别此 YSM 模型，角色卡也没有关联模型文件。请先从独立模型库选择或导入 .ysm / 模型 ZIP。')
  runtime.log('模型资源已准备，正在请求游戏重载 YSM 模型。')
  try{await runtime.reload()}catch(error){throw new Error('YSM 模型已复制，但游戏重载失败。请由有权限的玩家执行 /ysm model reload，或重启游戏后重试。原因：'+(error instanceof Error?error.message:String(error)))}
  const wait=runtime.wait??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)))
  for(let attempt=0;attempt<10;attempt++){
   options=await runtime.query();if(options.models.includes(look.model))break
   if(attempt<9)await wait(300)
  }
  if(!options.models.includes(look.model))throw new Error('模型已复制，但游戏仍未识别或未授权此模型：'+look.model+'。请确认此实例是世界主机、YSM 模型 ID 和授权，必要时重启游戏；连接其他服务器时也需在该服务器安装模型。')
 }
 const result=await runtime.apply(look)
 if(result.currentModel!==look.model||(look.texture&&result.currentTexture!==look.texture))throw new Error('游戏未确认角色卡的 YSM 外观，未标记应用成功')
 return result
}
