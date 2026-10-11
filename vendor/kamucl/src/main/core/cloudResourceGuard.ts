import path from 'node:path'
import { getSettings } from './settings'
import { resolveResourceDirectory } from './resourceDirectory'
import { samePath } from './folderPaths'
import { catalog, storage } from './nomadCloud'
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
    const separator = key.lastIndexOf(':')
    if (separator < 1) throw new Error('云端实例绑定无效，请重新绑定')
    ids.push(key.slice(0, separator))
  }
  if (!ids.length) return
  if (!storage().valid) throw new Error('请先设置有效的云端实例本地存放目录')
  const current = await catalog()
  assertCloudModPermission(current.instances as NomadCatalogInstance[], ids)
}
