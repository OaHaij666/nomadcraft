import fs from 'node:fs/promises'
import path from 'node:path'
import clientNetwork from '../../../bridge/client-network.json'
import { fileDigest, confinedFile } from './cloudSyncFiles'
import { distributionPath, type DistributionFile } from '../../../../mcsmanager/shared/nomad-distribution'

export async function cloudInstanceFiles(directory: string) {
  const result: DistributionFile[] = [];
  for (const top of [
    "mods",
    "config",
    "defaultconfigs",
    "kubejs",
    "scripts",
    "datapacks",
    "resourcepacks",
    "shaderpacks",
  ]) {
    const walk = async (relative: string) => {
      await confinedFile(directory, relative + "/.nc-directory-check");
      let entries;
      try {
        entries = await fs.readdir(path.join(directory, relative), {
          withFileTypes: true,
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const p = relative + "/" + entry.name;
        if (entry.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!entry.isFile()) continue;
        distributionPath(p);
        const file = await confinedFile(directory, p),
          stat = await fs.stat(file);
        const digest = await fileDigest(file);
        result.push({
          path: p,
          size: stat.size,
          sha256: digest,
          side:
            top === "resourcepacks" || top === "shaderpacks" || (top === "mods" && digest === clientNetwork.forge1201.sha256)
              ? "client"
              : "both",
          ownership: top === "mods" ? "managed" : "seed",
        });
        if (result.length > 20000) throw new Error("实例文件数量超过限制");
      }
    };
    await walk(top);
  }
  return result;
}
