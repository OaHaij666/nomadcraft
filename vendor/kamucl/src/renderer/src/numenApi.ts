import { invoke } from './api'
import type { CharacterCard, CharacterSummary, CharacterInput, CharacterBinding, YsmOptions } from '@shared/characterCard'

import type { AiSettingsPatch, AiSettingsView, NumenCommand, NumenSnapshot } from '@shared/numen'
import { NUMEN_EVENT } from '@shared/numen'
import type { InstanceTarget } from '@shared/instanceCenter'
const call = <T>(method: string,...args: unknown[]) => invoke<T>('numen:'+method,...args)
export const numenApi = {
  cards:()=>call<CharacterSummary[]>('cards'),
  cardGet:(id:string)=>call<CharacterCard>('cardGet',id),
  cardSave:(input:CharacterInput)=>call<CharacterCard>('cardSave',input),
  cardDuplicate:(id:string)=>call<CharacterCard>('cardDuplicate',id),
  cardDelete:(id:string)=>call<CharacterSummary[]>('cardDelete',id),
  cardSkin:()=>call<string|null>('cardSkin'),
  cardSkinExport:(id:string)=>call<string|null>('cardSkinExport',id),
  ysmOptions:(companion:string)=>call<YsmOptions>('ysmOptions',companion),
  cardYsmApply:(id:string,companion:string)=>call<YsmOptions>('cardYsmApply',id,companion),
  cardAvatar:()=>call<string|null>('cardAvatar'),
  cardImport:()=>call<CharacterCard|null>('cardImport'),
  cardExport:(id:string,format:'md'|'json')=>call<string|null>('cardExport',id,format),
  cardBind:(binding:CharacterBinding|null)=>call<NumenSnapshot>('cardBind',binding),
  settings: () => call<AiSettingsView>('settings'),
  saveSettings: (input:AiSettingsPatch)=>call<AiSettingsView>('saveSettings',input),
  testModel: ()=>call<boolean>('testModel'),
  snapshot:()=>call<NumenSnapshot>('snapshot'),
  bind:(target:InstanceTarget)=>call<NumenSnapshot>('bind',target),
  enableMcp:()=>call<NumenSnapshot>('enableMcp'),
  connect:()=>call<NumenSnapshot>('connect'),
  refresh:()=>call<NumenSnapshot>('refresh'),
  select:(id:string)=>call<NumenSnapshot>('select',id),
  delete:(id:string)=>call<NumenSnapshot>('delete',id),
  playerCommand:(action:string,companion:string,text?:string)=>call<NumenSnapshot>('playerCommand',action,companion,text),
  create:(name:string)=>call<NumenSnapshot>('create',name),
  start:(id:string)=>call<NumenSnapshot>('start',id),
  stop:()=>call<NumenSnapshot>('stop'),
  send:(text:string)=>call<NumenSnapshot>('send',text),
  command:(kind:NumenCommand)=>call<NumenSnapshot>('command',kind),
  clearLogs:()=>call<NumenSnapshot>('clearLogs'),
  clearHistory:()=>call<NumenSnapshot>('clearHistory'),
  exportLogs:()=>call<string|null>('exportLogs'),
  onState:(callback:(state:NumenSnapshot)=>void)=>window.kamucl.on(NUMEN_EVENT,value=>callback(value as NumenSnapshot))
}
