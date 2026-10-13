import fs from 'node:fs/promises'
import path from 'node:path'
import { fileDigest, atomicRecord } from './cloudSyncFiles'
import { resourceSource, type ResourceSource } from '../../../../mcsmanager/shared/nomad-resource-sources'

export async function rememberResourceOrigin(directory: string, file: string, provider: string, url: string) {
  const source = resourceSource({ provider, url })
  if (!source) return
  await atomicRecord(path.join(directory, (await fileDigest(file)) + '.sources.json'), [source])
}
export async function resourceOrigins(directory: string, hash: string): Promise<ResourceSource[]> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return []
  try {
    const file = path.join(directory, hash + '.sources.json')
    if ((await fs.stat(file)).size > 16384) return []
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return Array.isArray(value) ? value.slice(0, 4).map(resourceSource).filter((s): s is ResourceSource => !!s) : []
  } catch { return [] }
}
