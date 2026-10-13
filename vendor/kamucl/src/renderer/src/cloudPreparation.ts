import { reactive } from 'vue'
import { IPC_EVENT, type ProgressEvent } from '@shared/types'
import { errText, getSettings, launchGame, selectDir } from './api'
import { store, refreshCloudInstances, selectCloudInstance, toast } from './store'
import type { CloudInstalledVersion } from './store'
export const cloudPreparation = reactive<Record<string, {busy: boolean; message: string; state: string; progress?: number}>>({})
// One subscription for the lifetime of the renderer, independent of the active page.
if (typeof window !== 'undefined' && typeof window.kamucl?.on === 'function') window.kamucl.on(IPC_EVENT.progress, (value: unknown) => {
  const event = value as ProgressEvent
  const status = event.cloudPrepareKey ? cloudPreparation[event.cloudPrepareKey] : undefined
  if (status?.busy) { status.message = event.text; status.progress = event.overall ?? event.progress }
})
export const prepareKey = (ref: {instanceId: string; saveId?: string}) => JSON.stringify([store.cloudServiceId, ref.instanceId, ref.saveId ?? 'instance'])
export async function prepareCloud(ref: {instanceId: string; saveId?: string}, join = false) {
  const key = prepareKey(ref)
  if (cloudPreparation[key]?.busy) return
  cloudPreparation[key] = {busy: true, message: '正在准备，详细进度可在任务中心查看…', state: 'preparing'}
  try {
    const storage = await window.kamucl.invoke('nomad:storage') as {valid: boolean}
    if (!storage.valid) {
      cloudPreparation[key].message = '请选择云端实例的本地存放位置'
      const directory = await selectDir()
      if (!directory) { cloudPreparation[key] = {busy: false, message: '尚未选择本地存放位置', state: 'unbound'}; return }
      await window.kamucl.invoke('nomad:setStorage', directory)
      store.settings = await getSettings()
    }
    const result = await window.kamucl.invoke('nomad:distribution:prepare', ref) as {state: string; message: string; serviceId: string}
    cloudPreparation[key] = {busy: false, message: result.message, state: result.state}
    store.settings = await getSettings()
    await refreshCloudInstances()
    if (store.cloudServiceId !== result.serviceId) throw new Error('当前云端服务已切换，请重新选择实例')
    if (join && result.state === 'ready') {
      if (!store.selectedAccount) { toast('客户端文件已准备好，请选择游戏账号后加入', 'info'); store.currentView = 'accounts'; return result }
      // Recheck the pinned release and room immediately before launching.
      const plan = await window.kamucl.invoke('nomad:distribution:join', ref) as {target: {id: string; folder: string}; address: string}
      await launchGame(plan.target.id, plan.address, plan.target.folder)
    } else toast(result.message, result.state === 'ready' ? 'success' : 'info')
    return result
  } catch (error) {
    const message = errText(error)
    cloudPreparation[key] = {busy: false, state: 'error', message}
    toast('云端实例准备失败：' + message, 'error')
  } finally { cloudPreparation[key].busy = false }
}
export async function useCloudInstance(version: CloudInstalledVersion, join = false) {
  await prepareCloud({instanceId: version.cloudInstanceId, saveId: version.cloudSaveId}, join)
  const status = cloudPreparation[prepareKey({instanceId: version.cloudInstanceId, saveId: version.cloudSaveId})]
  if (!status || !['ready', 'room-stopped'].includes(status.state)) return
  await selectCloudInstance(version.id, true)
}
