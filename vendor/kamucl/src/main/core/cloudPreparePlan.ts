import crypto from 'node:crypto'
import { validateManifest, manifestDigest } from '../../../../mcsmanager/shared/nomad-distribution'
import type { InstallOptions } from '../../shared/types'
/** Older official runtime-only recipes contain no managed files to extract. */
export function clientRelease(release: any): any {
  if (!release || release.manifest || release.source !== 'official' || release.fileCount !== 0 || !release.install?.minecraft) return release
  const install = release.install
  if (Object.keys(install).some(key => !['minecraft', 'fabric', 'forge', 'neoforge', 'paper'].includes(key) && install[key])) return release
  const loader = install.forge ? 'forge' : install.neoforge ? 'neoforge' : install.fabric ? 'fabric' : 'vanilla'
  if (install.minecraft !== release.profile?.mcVersion || loader !== release.profile?.loader || (loader !== 'vanilla' && release.profile.loaderVersion !== install[loader])) return release
  const manifest = {schema: 1 as const, files: []}
  return {...release, manifest, manifestDigest: manifestDigest(manifest)}
}
/** A save always uses its pinned release, never the current instance profile. */
export function cloudPreparePlan(catalog: any, ref: {instanceId: string; saveId?: string}, serviceId: string) {
  const instance = catalog.instances?.find((i: any) => i.id === ref.instanceId)
  if (!instance) throw new Error('当前账号没有实例访问权限')
  const save = ref.saveId ? instance.saves?.find((s: any) => s.id === ref.saveId) : undefined
  if (ref.saveId && !save) throw new Error('当前账号没有存档访问权限')
  const release = clientRelease(save ? instance.releases?.find((r: any) => r.id === save.releaseId) : instance.releases?.slice(-1)[0])
  if (!release?.id || !release.profile?.mcVersion) throw new Error('此实例尚未发布可安装的游戏环境，请管理员创建发布版并为存档指定版本')
  if (!release.manifest) throw new Error('此发布版没有文件清单，请管理员发布完整环境；旧整合包需要先转换为发布版')
  validateManifest(release.manifest, Number.MAX_SAFE_INTEGER)
  const profile = release.profile
  const loader = ['vanilla', 'paper', undefined, null, ''].includes(profile.loader) ? undefined : profile.loader
  if (loader && !['fabric', 'forge', 'neoforge', 'quilt'].includes(loader)) throw new Error('此发布版的客户端加载器暂不支持自动安装：' + loader)
  if (loader && !profile.loaderVersion) throw new Error('云端发布版未指定加载器版本，请管理员补齐后重新发布')
  const scope = crypto.createHash('sha256').update(JSON.stringify([serviceId, ref.instanceId, ref.saveId ?? 'instance'])).digest('hex')
  const runtime = crypto.createHash('sha256').update(JSON.stringify([profile.mcVersion, loader ?? 'vanilla', profile.loaderVersion ?? ''])).digest('hex')
  const name = 'nc-' + scope.slice(0, 12) + '-' + runtime.slice(0, 12)
  const options: InstallOptions = {instanceName: name, ...(loader ? {loader, loaderVersion: profile.loaderVersion} : {})}
  return {instance, save, release, scope, runtime, name, options}
}

export function cloudPreparedRoom(save: any) {
  if (save?.hosting?.joinAddress) return {state: 'ready', message: '可以加入', address: save.hosting.joinAddress}
  if (save?.hosting?.phase === 'failed' && save.hosting.error) return {state: 'room-stopped', message: '文件已准备好，房间启动失败：' + save.hosting.error}
  if (save?.hosting?.phase === 'starting') return {state: 'room-stopped', message: '文件已准备好，房间正在启动，请稍后再加入'}
  return {state: 'room-stopped', message: save ? '文件已准备好，房间未启动' : '文件已准备好，请选择存档房间'}
}
