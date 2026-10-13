import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { pipeline as rawPipeline } from "stream";
import { promisify } from "util";
const pipeline = promisify(rawPipeline);
import type { Readable } from "stream";
import type { IStorage } from "../common/storage/storage_interface";
import type { CatalogActor } from "../../../../shared/nomad-catalog";
import {
  validateManifest,
  type DistributionManifest,
  type DistributionFile
} from "../../../../shared/nomad-distribution";
import { NomadCatalog, CatalogError } from "./nomad_catalog";
interface ModelApplication {
  id: string;
  instanceId: string;
  saveId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  manifest: DistributionManifest;
  status: "uploading" | "pending" | "approved" | "rejected";
  revision: number;
  createdAt: number;
  reviewer?: string;
  reason?: string;
  deployment?: { epoch: number; state: "reload-requested" | "failed"; at: number };
}
class State {
  applications: ModelApplication[] = [];
}
const fail = (s: number, c: string): never => {
  throw new CatalogError(s, c);
};
export class NomadModels {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: () => IStorage,
    private catalog: NomadCatalog,
    private directory = path.resolve("data/NomadModelApplications")
  ) {}
  private mutate<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
    const job = this.queue.then(async () => {
      const s =
        (await this.storage().load("NomadModelApplications", State, "applications")) ?? new State();
      const result = await fn(s);
      await this.storage().store("NomadModelApplications", "applications", s);
      return structuredClone(result);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  private async membership(actor: CatalogActor, instanceId: string, saveId: string) {
    const i = (await this.catalog.list(actor)).instances.find(
      (i) => i.id === instanceId && i.saves.some((s) => s.id === saveId)
    );
    if (!i) fail(403, "model_instance_forbidden");
    return i!;
  }
  private application(s: State, id: string) {
    const a = s.applications.find((a) => a.id === id);
    if (!a) fail(404, "model_application_not_found");
    return a!;
  }
  file(id: string, hash: string) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash))
      fail(400, "invalid_model_asset");
    return path.join(this.directory, id, hash);
  }
  async create(actor: CatalogActor, input: any) {
    if (
      !input ||
      typeof input.instanceId !== "string" ||
      typeof input.saveId !== "string" ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 120
    )
      fail(400, "invalid_model_application");
    await this.membership(actor, input.instanceId, input.saveId);
    const manifest = validateManifest(input.manifest, 256 * 1024 * 1024);
    if (
      !manifest.files.length ||
      manifest.files.length > 6000 ||
      manifest.files.some(
        (f) =>
          !f.path.startsWith("config/yes_steve_model/custom/") ||
          !/\.(ysm|json|png|webp|jpg|jpeg|ogg|wav)$/i.test(f.path) ||
          f.size > 128 * 1024 * 1024
      )
    )
      fail(400, "invalid_ysm_resources");
    return this.mutate((s) => {
      if (
        s.applications.filter(
          (a) => a.ownerId === actor.id && ["uploading", "pending"].includes(a.status)
        ).length >= 10
      )
        fail(429, "model_application_limit");
      if (
        s.applications.length >= 500 ||
        s.applications.reduce(
          (total, a) => total + a.manifest.files.reduce((sum, f) => sum + f.size, 0),
          0
        ) +
          manifest.files.reduce((sum, f) => sum + f.size, 0) >
          5 * 1024 * 1024 * 1024
      )
        fail(429, "model_storage_limit");
      const a: ModelApplication = {
        id: crypto.randomUUID(),
        instanceId: input.instanceId,
        saveId: input.saveId,
        ownerId: actor.id,
        ownerName: actor.name,
        name: input.name.trim(),
        manifest,
        status: "uploading",
        revision: 1,
        createdAt: Date.now()
      };
      s.applications.push(a);
      return a;
    });
  }
  async blob(actor: CatalogActor, id: string, hash: string, source: Readable) {
    return this.mutate(async (s) => {
      const a = this.application(s, id);
      await this.membership(actor, a.instanceId, a.saveId);
      if (a.ownerId !== actor.id || a.status !== "uploading") fail(403, "model_upload_forbidden");
      const file = a.manifest.files.find((f) => f.sha256 === hash);
      if (!file) fail(400, "undeclared_model_blob");
      const dest = this.file(id, hash),
        temp = dest + "." + crypto.randomUUID() + ".part";
      await fs.mkdir(path.dirname(dest), { recursive: true });
      let size = 0;
      const digest = crypto.createHash("sha256");
      try {
        const { Transform } = await import("stream");
        const bounded = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > file!.size) {
              callback(new CatalogError(413, "model_blob_too_large"));
              return;
            }
            digest.update(chunk);
            callback(null, chunk);
          }
        });
        await pipeline(source, bounded, createWriteStream(temp, { flags: "wx" }));
        if (size !== file!.size || digest.digest("hex") !== hash) fail(400, "model_blob_mismatch");
        await fs.rename(temp, dest);
        return { size };
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
  }
  async commit(actor: CatalogActor, id: string) {
    return this.mutate(async (s) => {
      const a = this.application(s, id);
      await this.membership(actor, a.instanceId, a.saveId);
      if (a.ownerId !== actor.id || a.status !== "uploading") fail(403, "model_upload_forbidden");
      for (const f of a.manifest.files) {
        const stat = await fs.stat(this.file(id, f.sha256)).catch(() => null);
        if (stat?.size !== f.size) fail(409, "model_upload_incomplete");
      }
      a.status = "pending";
      a.revision++;
      return a;
    });
  }
  async list(actor: CatalogActor, instanceId: string, saveId: string) {
    const i = await this.membership(actor, instanceId, saveId);
    return this.mutate((s) =>
      s.applications
        .filter(
          (a) =>
            a.instanceId === instanceId &&
            a.saveId === saveId &&
            (a.ownerId === actor.id ||
              i.permissions.includes("models.approve") ||
              a.status === "approved")
        )
        .map((a) => ({ ...a, canReview: i.permissions.includes("models.approve") }))
    );
  }
  async review(actor: CatalogActor, id: string, input: any) {
    return this.mutate(async (s) => {
      const a = this.application(s, id),
        i = await this.membership(actor, a.instanceId, a.saveId);
      if (!i.permissions.includes("models.approve")) fail(403, "model_review_forbidden");
      if (
        a.status !== "pending" ||
        input?.revision !== a.revision ||
        !["approve", "reject"].includes(input.decision)
      )
        fail(409, "model_review_conflict");
      if (typeof input.reason !== "string" || input.reason.length > 1000)
        fail(400, "invalid_review_reason");
      if (input.decision === "approve") {
        const all = s.applications
          .filter((b) => b.id !== a.id && b.instanceId === a.instanceId && b.status === "approved")
          .reduce(
            (files: DistributionFile[], b) => files.concat(b.manifest.files),
            [] as DistributionFile[]
          );
        if (
          a.manifest.files.some((f) =>
            all.some(
              (old) => old.path.toLowerCase() === f.path.toLowerCase() && old.sha256 !== f.sha256
            )
          )
        )
          fail(409, "approved_model_path_conflict");
      }
      a.status = input.decision === "approve" ? "approved" : "rejected";
      a.reviewer = actor.id;
      a.reason = input.reason;
      a.revision++;
      return a;
    });
  }
  async approved(instanceId: string, saveId: string) {
    return this.mutate((s) =>
      s.applications.filter(
        (a) => a.instanceId === instanceId && a.saveId === saveId && a.status === "approved"
      )
    );
  }
  async deployment(
    instanceId: string,
    saveId: string,
    id: string,
    epoch: number,
    state: "reload-requested" | "failed"
  ) {
    return this.mutate((s) => {
      const a = this.application(s, id);
      if (a.instanceId !== instanceId || a.saveId !== saveId || a.status !== "approved")
        fail(403, "model_asset_not_approved");
      a.deployment = { epoch, state, at: Date.now() };
      return a.deployment;
    });
  }
  async approvedBlob(instanceId: string, saveId: string, id: string, hash: string) {
    const list = await this.approved(instanceId, saveId);
    if (!list.some((a) => a.id === id && a.manifest.files.some((f) => f.sha256 === hash)))
      fail(403, "model_asset_not_approved");
    return this.file(id, hash);
  }
  async read(actor: CatalogActor, id: string, hash: string) {
    return this.mutate(async (s) => {
      const a = this.application(s, id),
        i = await this.membership(actor, a.instanceId, a.saveId);
      if (
        a.ownerId !== actor.id &&
        !i.permissions.includes("models.approve") &&
        a.status !== "approved"
      )
        fail(403, "model_asset_forbidden");
      if (!a.manifest.files.some((f) => f.sha256 === hash)) fail(404, "model_blob_not_found");
      return this.file(id, hash);
    });
  }
}
