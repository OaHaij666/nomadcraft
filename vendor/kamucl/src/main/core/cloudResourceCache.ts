import fs from 'node:fs/promises'
import path from 'node:path'
import { fileDigest, confinedFile } from './cloudSyncFiles'
import { withFileJob } from './fileJobs'
import type { DistributionFile } from '../../../../mcsmanager/shared/nomad-distribution'
import { publicResourcePath, resourceSource, type ResourceSource } from '../../../../mcsmanager/shared/nomad-resource-sources'

export type ResourceLocation = 'instance' | 'cache' | 'local' | 'upstream' | 'cloud'
const pins = new Map<string, number>()
async function matches(file: string, expected: DistributionFile) {
  try {
    const stat = await fs.lstat(file)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === expected.size && await fileDigest(file) === expected.sha256
  } catch (e) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) return false
    throw e
  }
}

/** One content cache for every service/release. Each session pins files through activation. */
export class CloudResourceCache {
  private held = new Set<string>()
  private index?: Promise<Map<number, string[]>>
  private hashes = new Map<string, string>()
  constructor(readonly directory: string, private localDirectories: () => Promise<string[]>) {}

  private candidates() {
    return this.index ??= (async () => {
      const index = new Map<number, string[]>()
      let count = 0
      for (const dir of new Set(await this.localDirectories())) {
        for (const top of ['mods', 'resourcepacks', 'shaderpacks']) {
          try {
            await confinedFile(dir, top + '/.nc-directory-check')
            for (const entry of await fs.readdir(path.join(dir, top), { withFileTypes: true })) {
              if (++count > 20000) return index
              if (!entry.isFile() || !publicResourcePath(top + '/' + entry.name)) continue
              const file = await confinedFile(dir, top + '/' + entry.name)
              const stat = await fs.lstat(file)
              if (!stat.isFile() || stat.isSymbolicLink()) continue
              const values = index.get(stat.size) ?? []
              values.push(file); index.set(stat.size, values)
            }
          } catch { /* Optional reuse never makes an otherwise usable instance fail. */ }
        }
      }
      return index
    })()
  }

  async obtain(file: DistributionFile, options: {
    instance: string; legacy?: string; signal: AbortSignal;
    sources: () => Promise<ResourceSource[]>;
    upstream: (dest: string, sources: ResourceSource[]) => Promise<void>;
    cloud: (dest: string) => Promise<void>;
    progress: (location: ResourceLocation) => void;
  }): Promise<{ location: ResourceLocation; file?: string }> {
    options.signal.throwIfAborted()
    const current = await confinedFile(options.instance, file.path)
    if (await matches(current, file)) { options.progress('instance'); return { location: 'instance' } }
    const dest = path.join(this.directory, file.sha256)
    if (!this.held.has(dest)) { this.held.add(dest); pins.set(dest, (pins.get(dest) ?? 0) + 1) }
    return withFileJob(dest + '.lock', options.signal, async () => {
      await fs.mkdir(this.directory, { recursive: true })
      if (await matches(dest, file)) {
        await fs.utimes(dest, new Date(), new Date())
        options.progress('cache'); return { location: 'cache', file: dest }
      }
      // Incomplete or corrupt entries never become trusted simply because their name is a hash.
      await fs.unlink(dest).catch(e => { if (e.code !== 'ENOENT') throw e })
      const temp = dest + '.transfer'
      let location: ResourceLocation = 'cloud'
      try {
        await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e })
        const local = options.legacy && await matches(options.legacy, file) ? options.legacy : undefined
        if (local) { await fs.copyFile(local, temp); location = 'cache' }
        else if (publicResourcePath(file.path)) {
          for (const candidate of (await this.candidates()).get(file.size) ?? []) {
            options.signal.throwIfAborted()
            const digest = this.hashes.get(candidate) ?? await fileDigest(candidate).catch(() => '')
            this.hashes.set(candidate, digest)
            if (digest !== file.sha256) continue
            await fs.copyFile(candidate, temp).catch(() => {})
            if (await matches(temp, file)) { location = 'local'; break }
          }
        }
        if (!await matches(temp, file)) {
          let resolved: ResourceSource[] = []
          if (publicResourcePath(file.path)) {
            try { resolved = await options.sources() } catch { options.signal.throwIfAborted() }
          }
          const sources = resolved.map(resourceSource).filter((s): s is ResourceSource => !!s)
          options.signal.throwIfAborted()
          if (sources.length) {
            options.progress('upstream')
            try {
              await options.upstream(temp, sources)
              if (!await matches(temp, file)) throw new Error('上游文件校验失败')
              location = 'upstream'
            } catch {
              options.signal.throwIfAborted()
              await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e })
            }
          }
          if (!await matches(temp, file)) {
            options.progress('cloud')
            await options.cloud(temp)
            location = 'cloud'
          }
        }
        options.signal.throwIfAborted()
        if (!await matches(temp, file)) throw new Error('资源文件校验失败：' + file.path)
        await fs.rename(temp, dest)
        options.progress(location)
        return { location, file: dest }
      } finally {
        await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e })
        const segments = path.resolve(temp + '.segments-cache')
        if (path.dirname(segments) !== path.resolve(this.directory)) throw new Error('资源缓存路径无效')
        await fs.rm(segments, { recursive: true, force: true })
      }
    })
  }

  async close() {
    for (const file of this.held) {
      const count = (pins.get(file) ?? 1) - 1
      if (count) pins.set(file, count); else pins.delete(file)
    }
    this.held.clear()
    await pruneResourceCache(this.directory)
  }
}

/** Automatic limits; installed instances hold independent copies. No setup needed. */
export async function pruneResourceCache(directory: string, maxBytes = 10 * 1024 ** 3, maxAge = 30 * 86400000) {
  return withFileJob(directory + '.maintenance', undefined, async () => {
    const entries = [] as Array<{ file: string; size: number; time: number }>
    for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const file = path.join(directory, name), stat = await fs.lstat(file).catch(() => null)
      if (stat?.isFile() && !stat.isSymbolicLink()) entries.push({ file, size: stat.size, time: stat.mtimeMs })
    }
    let bytes = entries.reduce((n, e) => n + e.size, 0)
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (bytes <= maxBytes && Date.now() - entry.time < maxAge) continue
      await withFileJob(entry.file + '.lock', undefined, async () => {
        if (pins.has(entry.file)) return
        // A different session may have refreshed this entry while maintenance waited.
        const stat = await fs.lstat(entry.file).catch(() => null)
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs !== entry.time) return
        await fs.unlink(entry.file); bytes -= entry.size
      })
    }
  })
}
