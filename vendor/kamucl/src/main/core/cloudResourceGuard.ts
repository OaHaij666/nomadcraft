import path from 'node:path'
import { getSettings } from './settings'
import { resolveResourceDirectory } from './resourceDirectory'
import { samePath } from './folderPaths'
import { catalog, storage, status } from './nomadCloud'
import { assertCloudModPermission } from './cloudResourcePolicy'
import type { NomadCatalogInstance } from '../../shared/nomad'

/** Resolve actual directories so the local alias of a cloud binding cannot bypass permissions. */
export async function assertCloudModsWritable(directory: string): Promise<void> {
  if (path.basename(directory).toLowerCase() !== 'mods') return
  const ids: string[] = []
  for (const [key, binding] of Object.entries(getSettings().cloudInstanceBindings ?? {})) {
    if (!binding.localVersionId || !binding.localFolder) continue
    let bound: string
    try { bound = await resolveResourceDirectory(binding.localFolder, binding.localVersionId, 'mods') }
    catch { continue }
    if (!samePath(bound, directory)) continue
    let id:string
    try {const identity=JSON.parse(key);if(identity[0]!==status().serviceId)throw new Error('云端实例属于另一个服务，请登录对应云端');id=identity[1]} catch(error) {if(key.startsWith('['))throw error;throw new Error('旧云端绑定需要在当前服务重新绑定，原文件已保留')}
    ids.push(id)
  }
  if (!ids.length) return
  if (!storage().valid) throw new Error('请先设置有效的云端实例本地存放目录')
  const current = await catalog()
  assertCloudModPermission(current.instances as NomadCatalogInstance[], ids)
}
