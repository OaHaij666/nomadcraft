import { invoke } from './api'
import type { YsmAsset,YsmPreview,DefaultYsm } from '@shared/ysm'
import type { InstanceTarget } from '@shared/instanceCenter'
export const ysmApi={list:()=>invoke<YsmAsset[]>('ysm:list'),preview:(id:string)=>invoke<YsmPreview>('ysm:preview',id),import:()=>invoke<YsmAsset|null>('ysm:import'),defaults:()=>invoke<DefaultYsm>('ysm:defaults'),setDefaults:(value:DefaultYsm)=>invoke<DefaultYsm>('ysm:setDefaults',value),install:(target:InstanceTarget,id:string)=>invoke<{count:number;modelId:string}>('ysm:install',target,id)}
