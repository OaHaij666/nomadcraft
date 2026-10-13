import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { CloudResourceCache, pruneResourceCache } from '../src/main/core/cloudResourceCache'
import { applyFiles } from '../src/main/core/cloudSyncFiles'
import { downloadFile } from '../src/main/core/download'
import { rememberResourceOrigin, resourceOrigins } from '../src/main/core/cloudResourceOrigins'
import { resourceSource } from '../../mcsmanager/shared/nomad-resource-sources'
import { validateManifest, manifestDigest, type DistributionFile } from '../../mcsmanager/shared/nomad-distribution'
const body = Buffer.from('exact release bytes')
const file: DistributionFile = { path: 'mods/example.jar', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), side: 'both', ownership: 'managed' }
const source = { provider: 'modrinth' as const, url: 'https://cdn.modrinth.com/data/project/versions/version/example.jar' }
async function fixture(run: (dir: string, cache: string, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-resources-'))
  const dir = path.join(root, 'game'), cache = path.join(root, 'cache')
  await fs.mkdir(path.join(dir, 'mods'), { recursive: true })
  try { await run(dir, cache, root) } finally { await fs.rm(root, { recursive: true, force: true }) }
}
function options(instance: string) {
  return { instance, signal: new AbortController().signal,
    sources: async () => [source], progress: () => {},
    upstream: async (dest: string) => { await fs.writeFile(dest, body) },
    cloud: async (dest: string) => { await fs.writeFile(dest, body) } }
}
test('matching instance performs no lookup/download or local scan', () => fixture(async (dir, cache) => {
  await fs.writeFile(path.join(dir, file.path), body)
  const store = new CloudResourceCache(cache, async () => { throw Error('unexpected scan') })
  const fail = async () => { throw Error('unexpected network') }
  assert.equal((await store.obtain(file, { ...options(dir), sources: fail, upstream: fail, cloud: fail })).location, 'instance')
  await store.close()
}))
test('renamed local MOD is copied by content and activation remains independent', () => fixture(async (dir, cache, root) => {
  const other = path.join(root, 'other'); await fs.mkdir(path.join(other, 'mods'), { recursive: true })
  await fs.writeFile(path.join(other, 'mods/renamed.jar'), body)
  const store = new CloudResourceCache(cache, async () => [other])
  const fail = async () => { throw Error('unexpected network') }
  const got = await store.obtain(file, { ...options(dir), sources: fail, upstream: fail, cloud: fail })
  assert.equal(got.location, 'local')
  const manifest = { schema: 1 as const, files: [file] }
  await applyFiles(dir, { serviceId: 's', instanceId: 'i', releaseId: 'r', manifest, digest: manifestDigest(manifest), verifiedAt: Date.now() }, { [file.path]: got.file! }, [], async () => {})
  await fs.writeFile(path.join(dir, file.path), 'user modified')
  assert.deepEqual(await fs.readFile(got.file!), body)
  assert.deepEqual(await fs.readFile(path.join(other, 'mods/renamed.jar')), body)
  await store.close()
}))
test('upstream success skips cloud; next instance reuses global cache', () => fixture(async (dir, cache) => {
  let cloud = 0, upstream = 0, lookup = 0
  const store = new CloudResourceCache(cache, async () => [])
  const opts = { ...options(dir), sources: async () => { lookup++; return [source] },
    upstream: async (dest: string) => { upstream++; await fs.writeFile(dest, body) },
    cloud: async () => { cloud++; throw Error('unexpected cloud') } }
  assert.equal((await store.obtain(file, opts)).location, 'upstream')
  await store.close()
  const second = new CloudResourceCache(cache, async () => [])
  assert.equal((await second.obtain(file, opts)).location, 'cache')
  assert.deepEqual({ cloud, upstream, lookup }, { cloud: 0, upstream: 1, lookup: 1 })
  await second.close()
}))
test('corrupt upstream falls back; corrupt cloud never enters verified cache', () => fixture(async (dir, cache) => {
  let fallback = 0
  const store = new CloudResourceCache(cache, async () => [])
  const opts = { ...options(dir), upstream: async (dest: string) => { await fs.writeFile(dest, Buffer.alloc(body.length)) },
    cloud: async (dest: string) => { fallback++; await fs.writeFile(dest, body) } }
  assert.equal((await store.obtain(file, opts)).location, 'cloud'); assert.equal(fallback, 1)
  await fs.writeFile(path.join(cache, file.sha256), 'corrupt')
  await assert.rejects(store.obtain(file, { ...opts, cloud: opts.upstream }), /校验/)
  await assert.rejects(fs.stat(path.join(cache, file.sha256)))
  await store.close()
}))
test('cancellation does not silently start cloud fallback', () => fixture(async (dir, cache) => {
  const controller = new AbortController(); let cloud = 0
  const store = new CloudResourceCache(cache, async () => [])
  await assert.rejects(store.obtain(file, { ...options(dir), signal: controller.signal,
    upstream: async () => { controller.abort(); throw Error('cancelled') }, cloud: async () => { cloud++ } }))
  assert.equal(cloud, 0); await store.close()
}))
test('concurrent sessions download identical content only once and keep pins during maintenance', () => fixture(async (dir, cache) => {
  let count = 0
  const a = new CloudResourceCache(cache, async () => []), b = new CloudResourceCache(cache, async () => [])
  const opts = { ...options(dir), upstream: async (dest: string) => { count++; await fs.writeFile(dest, body) } }
  const got = await Promise.all([a.obtain(file, opts), b.obtain(file, opts)])
  assert.equal(count, 1); assert.deepEqual(got.map(x => x.location).sort(), ['cache', 'upstream'])
  await pruneResourceCache(cache, 0, 0); assert.deepEqual(await fs.readFile(got[0].file!), body)
  await a.close(); await pruneResourceCache(cache, 0, 0); assert.deepEqual(await fs.readFile(got[0].file!), body)
  await b.close(); await pruneResourceCache(cache, 0, 0); await assert.rejects(fs.stat(got[0].file!))
}))
test('source metadata survives normalization without changing existing manifest identity', async () => {
  const plain = { schema: 1 as const, files: [file] }, withSources = { schema: 1 as const, files: [{ ...file, sources: [source] }] }
  assert.deepEqual(validateManifest(withSources).files[0].sources, [source])
  const legacy = crypto.createHash('sha256').update(JSON.stringify(validateManifest(plain))).digest('hex')
  assert.equal(manifestDigest(plain), legacy); assert.equal(manifestDigest(withSources), legacy)
  for (const url of ['http://cdn.modrinth.com/data/a', 'https://cdn.modrinth.com.evil.test/data/a', 'https://user:secret@cdn.modrinth.com/data/a', 'https://cdn.modrinth.com/data/a?token=secret', 'https://127.0.0.1/data/a'])
    assert.equal(resourceSource({ provider: 'modrinth', url }), undefined)
  assert.equal(validateManifest({ schema: 1, files: [{ ...file, path: 'config/private.json', sources: [source] }] }).files[0].sources, undefined)
})
test('resource origin is recorded by content hash, not a filename', () => fixture(async (dir, cache) => {
  const local = path.join(dir, file.path); await fs.writeFile(local, body)
  await rememberResourceOrigin(cache, local, source.provider, source.url)
  assert.deepEqual(await resourceOrigins(cache, file.sha256), [source])
  await rememberResourceOrigin(cache, local, 'curseforge', 'https://example.test/token?key=secret')
  assert.deepEqual(await resourceOrigins(cache, file.sha256), [source])
}))
test('real HTTP transfer uses existing downloader with SHA256 and then reuses cache without another request', () => fixture(async (dir, cache) => {
  let requests = 0, cloud = 0
  const server = http.createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Length': body.length }); res.end(body) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const store = new CloudResourceCache(cache, async () => [])
  try {
    const opts = { ...options(dir), upstream: (dest: string) => downloadFile('http://127.0.0.1:' + address.port + '/fixture.jar', dest, undefined, undefined, 'official', undefined, [], { sha256: file.sha256, size: file.size }),
      cloud: async () => { cloud++; throw Error('unexpected cloud') } }
    assert.equal((await store.obtain(file, opts)).location, 'upstream')
    assert.equal((await store.obtain(file, opts)).location, 'cache')
    assert.equal(requests, 1); assert.equal(cloud, 0)
  } finally { await store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}))

test('optional source lookup failure and private config both use cloud automatically', () => fixture(async (dir, cache) => {
  const store = new CloudResourceCache(cache, async () => []); let clouds = 0, lookups = 0
  const opts = { ...options(dir), sources: async () => { lookups++; throw Error('metadata offline') },
    cloud: async (dest: string) => { clouds++; await fs.writeFile(dest, body) } }
  assert.equal((await store.obtain(file, opts)).location, 'cloud')
  await fs.unlink(path.join(cache, file.sha256))
  assert.equal((await store.obtain({ ...file, path: 'config/default.txt' }, opts)).location, 'cloud')
  assert.equal(clouds, 2); assert.equal(lookups, 1)
  await store.close()
}))
