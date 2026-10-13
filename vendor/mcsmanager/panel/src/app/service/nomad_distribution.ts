import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import * as yazl from "yazl";
import {
  DistributionManifest,
  validateManifest,
  manifestDigest
} from "../../../../shared/nomad-distribution";
import type { CatalogActor, PublishedRelease } from "../../../../shared/nomad-catalog";
import type { IStorage } from "../common/storage/storage_interface";
import { CatalogError, NomadCatalog } from "./nomad_catalog";
import { NomadPackages, inspectPackage } from "./nomad_packages";
import { uploadPolicy } from "./nomad_policy";
export interface PublicationDraft {
  id: string;
  actorId: string;
  instanceId: string;
  expected: { revision: number; baseReleaseId: string | null };
  manifest: DistributionManifest;
  digest: string;
  createdAt: number;
  expiresAt: number;
  releaseId: string;
  result?: PublishedRelease;
  cancelled?: boolean;
  lineage?: PublishedRelease["lineage"];
  importProfile?: PublishedRelease["profile"];
  createTarget?: {
    name: string;
    profile: any;
    server?: PublishedRelease["server"];
    serverArtifact?: PublishedRelease["serverArtifact"];
  };
}
class DistributionState {
  serviceId = crypto.randomUUID();
  drafts: PublicationDraft[] = [];
  peers: Array<{ id: string; name: string; origin: string; serviceId: string }> = [];
  jobs: any[] = [];
  acceptances: any[] = [];
}
const fail = (status: number, code: string): never => {
  throw new CatalogError(status, code);
};
export async function hashFile(file: string) {
  const h = crypto.createHash("sha256");
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest("hex");
}
export class NomadDistribution {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: () => IStorage,
    readonly catalog: NomadCatalog,
    readonly directory = path.resolve("data", "NomadDistribution"),
    private quota = () => uploadPolicy().maxBytes
  ) {}
  private async load(): Promise<DistributionState> {
    return (
      (await this.storage().load("NomadDistribution", DistributionState, "state")) ??
      new DistributionState()
    );
  }
  async mutate<T>(fn: (s: DistributionState) => Promise<T> | T): Promise<T> {
    const p = this.queue.then(async () => {
      const s = await this.load();
      const r = await fn(s);
      await this.storage().store("NomadDistribution", "state", s);
      return structuredClone(r);
    });
    this.queue = p.catch(() => undefined);
    return p;
  }
  async state() {
    await this.queue;
    return this.load();
  }
  async identity() {
    return this.mutate((s) => ({
      serviceId: s.serviceId,
      manifestVersions: [1],
      capabilities: ["manifest-publication", "local-sync", "peer-push", "vanilla-hosting"]
    }));
  }
  limit(){return this.quota()}
  blob(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) fail(400, "invalid_blob_hash");
    return path.join(this.directory, "blobs", hash.slice(0, 2), hash);
  }
  async instance(actor: CatalogActor, id: string) {
    const i = (await this.catalog.list(actor)).instances.find((v) => v.id === id);
    if (!i) fail(403, "forbidden");
    return i!;
  }
  async release(actor: CatalogActor, id: string, releaseId: string) {
    const i = await this.instance(actor, id),
      r = i.releases?.find((v) => v.id === releaseId);
    if (!r) fail(403, "forbidden");
    return r!;
  }
  async create(actor: CatalogActor, instanceId: string, input: any) {
    await this.catalog.checkPublish(actor, instanceId);
    const instance = await this.instance(actor, instanceId);
    const manifest = validateManifest(input.manifest, this.quota());
    if (
      !input.expected ||
      !Number.isSafeInteger(input.expected.revision) ||
      input.expected.revision !== instance.revision ||
      input.expected.baseReleaseId !== (instance.releases?.slice(-1)[0]?.id ?? null)
    )
      fail(409, "publication_base_conflict");
    return this.mutate((s) => {
      s.drafts = s.drafts.filter((d) => d.expiresAt > Date.now() || d.result);
      if (s.drafts.filter((d) => !d.result && !d.cancelled).length >= 32)
        fail(429, "publication_limit");
      const used = s.drafts
        .filter((d) => !d.result && !d.cancelled)
        .reduce((n, d) => n + d.manifest.files.reduce((b, f) => b + f.size, 0), 0);
      if (used + manifest.files.reduce((n, f) => n + f.size, 0) > this.quota() * 2)
        fail(413, "publication_storage_quota");
      const d: PublicationDraft = {
        id: crypto.randomUUID(),
        actorId: actor.id,
        instanceId,
        expected: input.expected,
        manifest,
        digest: manifestDigest(manifest),
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        releaseId: crypto.randomUUID()
      };
      s.drafts.push(d);
      return d;
    });
  }
  find(s: DistributionState, actor: CatalogActor, id: string) {
    const d = s.drafts.find((v) => v.id === id);
    if (!d || d.actorId !== actor.id) fail(403, "publication_forbidden");
    if (d!.cancelled || (!d!.result && d!.expiresAt < Date.now())) fail(410, "publication_expired");
    return d!;
  }
  async checkDraft(actor: CatalogActor, d: PublicationDraft) {
    if (d.createTarget) {
      if (!(await this.catalog.list(actor)).canCreate) fail(403, "creation_forbidden");
    } else await this.catalog.checkPublish(actor, d.instanceId);
  }
  async status(actor: CatalogActor, id: string) {
    const s = await this.state(),
      d = this.find(s, actor, id);
    await this.checkDraft(actor, d);
    const missing = [] as Array<{ sha256: string; size: number; offset: number }>;
    for (const f of d.manifest.files) {
      const blob = this.blob(f.sha256),
        stat = await fs.promises.stat(blob).catch(() => null);
      if (stat?.size === f.size && (await hashFile(blob)) === f.sha256) continue;
      const part = path.join(this.directory, "drafts", d.id, f.sha256 + ".part");
      missing.push({
        sha256: f.sha256,
        size: f.size,
        offset: (await fs.promises.stat(part).catch(() => null))?.size ?? 0
      });
    }
    return { ...d, missing: [...new Map(missing.map((f) => [f.sha256, f])).values()] };
  }
  async chunk(actor: CatalogActor, id: string, hash: string, offset: number, stream: Readable) {
    return this.mutate(async (s) => {
      const d = this.find(s, actor, id);
      await this.checkDraft(actor, d);
      if (d.result) fail(409, "already_published");
      const f = d.manifest.files.find((v) => v.sha256 === hash);
      if (!f) fail(403, "blob_outside_manifest");
      if (f!.size > this.quota()) fail(413, "distribution_quota_exceeded");
      const dest = this.blob(hash);
      const existing = await fs.promises.stat(dest).catch(() => null);
      if (existing) {
        if (existing.size !== f!.size) fail(422, "blob_size_mismatch");
        if ((await hashFile(dest)) !== hash) fail(500, "blob_corrupt");
        stream.resume();
        return { offset: f!.size, complete: true };
      }
      const part = path.join(this.directory, "drafts", d.id, hash + ".part");
      await fs.promises.mkdir(path.dirname(part), { recursive: true });
      const size = (await fs.promises.stat(part).catch(() => null))?.size ?? 0;
      if (!Number.isSafeInteger(offset) || offset !== size) fail(409, "upload_offset_conflict");
      let bytes = 0;
      let deadline = setTimeout(() => stream.destroy(new Error("upload_deadline")), 30000);
      const file = await fs.promises.open(part, "a");
      try {
        for await (const value of stream) {
          clearTimeout(deadline);deadline=setTimeout(()=>stream.destroy(new Error('upload_deadline')),30000);
          const c = Buffer.from(value);
          bytes += c.length;
          if (bytes > 4 * 1024 ** 2 || size + bytes > f!.size) fail(413, "upload_chunk_limit");
          await file.write(c);
        }
      } catch (error) {
        await file.truncate(size);
        throw error;
      } finally {
        clearTimeout(deadline);
        await file.close();
      }
      const next = size + bytes;
      if (next === f!.size) {
        if ((await hashFile(part)) !== hash) {
          await fs.promises.unlink(part);
          fail(422, "blob_hash_mismatch");
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.rename(part, dest);
      }
      return { offset: next, complete: next === f!.size };
    });
  }
  async commit(actor: CatalogActor, id: string) {
    return this.mutate(async (s) => {
      const d = this.find(s, actor, id);
      await this.checkDraft(actor, d);
      if (d.result) return d.result;
      const listing = await this.catalog.list(actor);
      const instance = d.createTarget
        ? {
            id: d.instanceId,
            name: d.createTarget.name,
            profile: d.createTarget.profile,
            revision: 0,
            releases: [] as PublishedRelease[]
          }
        : await this.instance(actor, d.instanceId);
      const imported = listing.instances.find((i) => i.releases?.some((r) => r.id === d.releaseId));
      if (imported) {
        d.instanceId = imported.id;
        d.result = imported.releases!.find((r) => r.id === d.releaseId)!;
        return d.result;
      }
      const already = instance.releases?.find((r) => r.id === d.releaseId);
      if (already) {
        d.result = already;
        return already;
      }
      if (
        instance.revision !== d.expected.revision ||
        (instance.releases?.slice(-1)[0]?.id ?? null) !== d.expected.baseReleaseId
      )
        fail(409, "publication_base_conflict");
      for (const f of d.manifest.files) {
        const stat = await fs.promises.stat(this.blob(f.sha256)).catch(() => null);
        if (stat?.size !== f.size || (await hashFile(this.blob(f.sha256))) !== f.sha256)
          fail(409, "publication_incomplete");
      }
      const staging = path.join(this.directory, "drafts", d.id, "release.mrpack");
      await fs.promises.mkdir(path.dirname(staging), { recursive: true });
      const zip = new yazl.ZipFile();
      const p = d.importProfile ?? instance.profile,
        dependencies: Record<string, string> = { minecraft: p.mcVersion };
      if (p.loader === "fabric") dependencies["fabric-loader"] = p.loaderVersion;
      if (p.loader === "forge") dependencies.forge = p.loaderVersion;
      if (p.loader === "neoforge") dependencies.neoforge = p.loaderVersion;
      zip.addBuffer(
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            game: "minecraft",
            name: instance.name,
            versionId: d.releaseId,
            files: [],
            dependencies
          })
        ),
        "modrinth.index.json"
      );
      for (const f of d.manifest.files)
        zip.addFile(
          this.blob(f.sha256),
          (f.side === "server"
            ? "server-overrides/"
            : f.side === "client"
              ? "client-overrides/"
              : "overrides/") + f.path
        );
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(staging);
        out.on("finish", resolve);
        out.on("error", reject);
        zip.outputStream.on("error", reject);
        zip.outputStream.pipe(out);
        zip.end();
      });
      const packages = new NomadPackages(path.resolve(this.directory, "..", "NomadPackages"));
      const inspected = await inspectPackage(staging, {
        maxGiB: this.quota() / 1024 ** 3,
        maxBytes: this.quota(),
        maxExpandedBytes: this.quota() * 4
      });
      const archive = await packages.store(staging, inspected, actor.id, "upload", this.quota());
      const previous = instance.releases?.slice(-1)[0];
      const release: PublishedRelease = {
        ...archive,
        id: d.releaseId,
        profile: {
          ...p,
          artifact: archive.fileName,
          artifactSha256: archive.sha256,
          packRevision: d.releaseId
        },
        server: d.createTarget?.server ?? previous?.server,
        serverArtifact: d.createTarget?.serverArtifact ?? previous?.serverArtifact,
        install: previous?.install,
        manifest: d.manifest,
        manifestDigest: d.digest,
        lineage: d.lineage
      };
      const result = d.createTarget
        ? (
            await this.catalog.create(
              actor,
              {
                name: d.createTarget.name,
                description: "Imported cloud environment",
                profile: release.profile
              },
              release
            )
          ).releases![0]
        : await this.catalog.publish(actor, d.instanceId, release, d.expected);
      if (d.createTarget)
        d.instanceId = (await this.catalog.list(actor)).instances.find((i) =>
          i.releases?.some((r) => r.id === result.id)
        )!.id;
      d.result = result;
      return result;
    });
  }
  async cancel(actor: CatalogActor, id: string) {
    return this.mutate((s) => {
      const d = this.find(s, actor, id);
      if (d.result) fail(409, "already_published");
      d.cancelled = true;
      return { cancelled: true };
    });
  }
  async authorizedBlob(actor: CatalogActor, instanceId: string, releaseId: string, hash: string) {
    const r = await this.release(actor, instanceId, releaseId);
    const f = r.manifest?.files.find((v) => v.sha256 === hash);
    if (!f) fail(403, "blob_outside_manifest");
    const file = this.blob(hash);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat?.size !== f!.size) fail(404, "blob_missing");
    return file;
  }
}
