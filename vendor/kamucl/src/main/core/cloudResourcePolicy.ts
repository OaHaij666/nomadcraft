import type { NomadCatalogInstance } from '../../shared/nomad'

/** Permissions belong to the logical instance, not an individual save. */
export function assertCloudModPermission(instances: NomadCatalogInstance[], ids: string[]): void {
  for (const id of new Set(ids)) {
    const instance = instances.find(value => value.id === id)
    if (!instance?.permissions?.includes('mods.manage')) throw new Error('没有此云端实例的 MOD 管理权限；请联系实例管理员授权')
  }
}
