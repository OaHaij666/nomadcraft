import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import { DistributionFile } from "../../../../shared/nomad-distribution";
import { publicResourcePath, modrinthSource, resourceSource, ResourceSource } from "../../../../shared/nomad-resource-sources";

const requestVersions = async (hashes: string[]): Promise<Record<string, unknown>> => {
  const response = await axios.post("https://api.modrinth.com/v2/version_files",
    { hashes, algorithm: "sha512" },
    { timeout: 8000, maxContentLength: 2 * 1024 ** 2, maxRedirects: 0,
      headers: { "User-Agent": "NomadCraft/0.1.0 (resource-distribution)" } });
  return response.data;
};

/** Metadata lookup only. Resource bytes still go directly from CDN to player. */
export class NomadResourceSources {
  private cache = new Map<string, { expires: number; sources: ResourceSource[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<Record<string, ResourceSource[]>>>();
  constructor(private request = requestVersions) {}

  resolve(files: DistributionFile[], blob: (hash: string) => string) {
    const key = [...new Set(files.filter(f => f.side !== "server" && publicResourcePath(f.path)).map(f => f.sha256))].sort().join(",");
    const existing = this.jobs.get(key);
    if (existing) return existing;
    if (this.jobs.size >= 4) return Promise.resolve({} as Record<string, ResourceSource[]>);
    const job = this.queue.then(() => this.lookup(files, blob)).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
    this.queue = job.catch(() => {});
    return job;
  }

  private async lookup(files: DistributionFile[], blob: (hash: string) => string) {
    const result: Record<string, ResourceSource[]> = {};
    const missing: Array<{ file: DistributionFile; sha512: string }> = [];
    for (const file of files) {
      if (!publicResourcePath(file.path) || file.side === "server") continue;
      const supplied = (file.sources ?? []).map(resourceSource).filter((s): s is ResourceSource => !!s);
      if (supplied.length) { result[file.sha256] = supplied; continue; }
      const cached = this.cache.get(file.sha256);
      if (cached && cached.expires > Date.now()) { result[file.sha256] = cached.sources; continue; }
      // Never reveal a hash from configuration/private files to a third party.
      try {
        const sha512 = crypto.createHash("sha512"), sha256 = crypto.createHash("sha256");
        let size = 0;
        for await (const chunk of fs.createReadStream(blob(file.sha256))) {
          size += chunk.length;
          if (size > file.size) throw new Error("blob_size_mismatch");
          sha512.update(chunk); sha256.update(chunk);
        }
        if (size !== file.size || sha256.digest("hex") !== file.sha256) continue;
        missing.push({ file, sha512: sha512.digest("hex") });
      } catch { /* Unavailable optional metadata must not prevent cloud fallback. */ }
    }
    if (missing.length) {
      let versions: Record<string, unknown> = {};
      try { versions = await this.request(missing.map(f => f.sha512)); }
      catch { /* Upstream unavailable: cache a short negative result and use cloud. */ }
      for (const { file, sha512 } of missing) {
        const source = modrinthSource(versions?.[sha512], sha512, file.size);
        const sources = source ? [source] : [];
        result[file.sha256] = sources;
        this.cache.delete(file.sha256);
        this.cache.set(file.sha256, { expires: Date.now() + (source ? 86400000 : 300000), sources });
      }
      while (this.cache.size > 20000) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }
}
