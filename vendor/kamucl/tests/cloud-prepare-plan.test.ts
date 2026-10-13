import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudPreparePlan, cloudPreparedRoom } from '../src/main/core/cloudPreparePlan'
const release = (id: string, mcVersion = '1.20.1', loader = 'fabric', loaderVersion: string | undefined = '0.16.10') => ({id, profile: {mcVersion, loader, loaderVersion}, manifest: {schema: 1, files: []}})
const catalog = () => ({instances: [{id: 'i', profile: {mcVersion: '1.21.1'}, releases: [release('pinned'), release('latest', '1.21.1')], saves: [{id: 's', releaseId: 'pinned'}]}]})
test('save preparation uses exact pinned profile, even when instance/latest differs', () => {
  const plan = cloudPreparePlan(catalog(), {instanceId: 'i', saveId: 's'}, 'service')
  assert.equal(plan.release.id, 'pinned'); assert.equal(plan.release.profile.mcVersion, '1.20.1'); assert.equal(plan.options.loaderVersion, '0.16.10')
})
test('runtime directories separate services, saves and loaders but reuse file-only revisions', () => {
  const a = cloudPreparePlan(catalog(), {instanceId: 'i', saveId: 's'}, 'a')
  const b = cloudPreparePlan(catalog(), {instanceId: 'i', saveId: 's'}, 'b')
  assert.notEqual(a.scope, b.scope)
  const c = catalog(); c.instances[0].releases[0].id = 'new'; c.instances[0].saves[0].releaseId = 'new'
  assert.equal(a.name, cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a').name)
  c.instances[0].releases[0].profile.loaderVersion = '0.17.0'
  assert.notEqual(a.runtime, cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a').runtime)
})
test('missing pinned release and unpinned loader versions fail, never silently use latest', () => {
  const c = catalog(); c.instances[0].saves[0].releaseId = 'missing'
  assert.throws(() => cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a'), /尚未发布/)
  c.instances[0].saves[0].releaseId = 'pinned'; c.instances[0].releases[0].profile.loaderVersion = undefined
  assert.throws(() => cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a'), /未指定加载器/)
})
test('legacy missing manifests fail explicitly; Paper prepares a vanilla client', () => {
  const c = catalog(); const r = c.instances[0].releases[0]
  r.profile.loader = 'paper'
  assert.equal(cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a').options.loader, undefined)
  delete (r as any).manifest
  assert.throws(() => cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a'), /没有文件清单/)
})

test('room readiness distinguishes a ready address, starting, stopped and server failure', () => {
  assert.equal(cloudPreparedRoom({hosting:{joinAddress:'localhost:25565'}}).state, 'ready')
  assert.match(cloudPreparedRoom({hosting:{phase:'starting'}}).message, /正在启动/)
  assert.match(cloudPreparedRoom({hosting:{phase:'failed',error:'Java 版本错误'}}).message, /Java 版本错误/)
  assert.match(cloudPreparedRoom({}).message, /未启动/)
  assert.match(cloudPreparedRoom(undefined).message, /选择存档/)
})

test('older official runtime-only recipes are safe to prepare; uploaded packs and optional client files are not treated as empty', () => {
  const c = catalog(); const r: any = c.instances[0].releases[0]
  delete r.manifest; r.source = 'official'; r.fileCount = 0; r.install = {minecraft: '1.20.1', fabric: '0.16.10'}
  assert.deepEqual(cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a').release.manifest.files, [])
  r.install.fabricApi = 'extra'
  assert.throws(() => cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a'), /没有文件清单/)
  delete r.install.fabricApi; r.source = 'upload'
  assert.throws(() => cloudPreparePlan(c, {instanceId: 'i', saveId: 's'}, 'a'), /没有文件清单/)
})
