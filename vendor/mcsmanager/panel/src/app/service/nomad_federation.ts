import { resolveServer } from "./nomad_install";
import crypto from "crypto";
import fs from "fs";
import dns from "dns";
import http from "http";
import https from "https";
import { Readable } from "stream";
import { NomadDistribution, PublicationDraft } from "./nomad_distribution";
import { CatalogError, validateProfile } from "./nomad_catalog";
import type { CatalogActor } from "../../../../shared/nomad-catalog";
import { validateManifest, manifestDigest } from "../../../../shared/nomad-distribution";
const fail = (status: number, code: string): never => {
  throw new CatalogError(status, code);
};
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export async function peerRequest(
  peer: { origin: string; allowPrivate?: boolean },
  route: string,
  method = "GET",
  body?: Buffer | object,
  token?: string
): Promise<any> {
  const u = new URL(peer.origin);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["https:", "http:"].includes(u.protocol) ||
    (u.protocol === "http:" && !peer.allowPrivate)
  )
    fail(400, "invalid_peer_origin");
  const addresses = await dns.promises.lookup(u.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length) fail(502, "peer_dns_failed");
  for (const a of addresses) {
    const ip = a.address;
    const privateAddress =
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(ip) ||
      ip === "::1" ||
      /^(fc|fd|fe80|::ffff:)/i.test(ip);
    if (/^169\.254\.|^fe80/i.test(ip) || (privateAddress && !peer.allowPrivate))
      fail(400, "peer_network_forbidden");
  }
  const address = addresses[0];
  const base = peer.origin.replace(/\/$/, "");
  const url = new URL(base + "/" + route.replace(/^\//, ""));
  const data = Buffer.isBuffer(body)
    ? body
    : body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        lookup: ((_host: any, options: any, callback: any) =>
          options?.all
            ? callback(null, [address])
            : callback(null, address.address, address.family)) as any,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(data
            ? {
                "Content-Type": Buffer.isBuffer(body)
                  ? "application/octet-stream"
                  : "application/json",
                "Content-Length": data.length
              }
            : {})
        }
      },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (c) => {
          bytes += c.length;
          if (bytes > 10 * 1024 ** 2) {
            response.destroy();
            reject(new Error("peer_response_limit"));
            return;
          }
          chunks.push(c);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            if (!response.statusCode || response.statusCode >= 300)
              throw new Error("peer_rejected_" + response.statusCode);
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (json.status && json.status !== 200) throw new Error("peer_rejected");
            resolve(json.data ?? json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    const timer = setTimeout(() => request.destroy(new Error("peer_deadline")), 60000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    if (data) request.end(data);
    else request.end();
  });
}
export class NomadFederation {
  private receiving: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Promise<any>>();
  constructor(readonly distribution: NomadDistribution) {}
  async peers(actor: CatalogActor) {
    if (!actor.admin) fail(403, "admin_required");
    return (await this.distribution.state()).peers;
  }
  async configure(actor: CatalogActor, input: any) {
    if (!actor.admin) fail(403, "admin_required");
    const u = new URL(String(input.origin));
    if (u.pathname !== "/" || u.username || u.password || u.search || u.hash)
      fail(400, "peer_root_required");
    const peer = {
      id: crypto.randomUUID(),
      name: String(input.name ?? "Peer").slice(0, 80),
      origin: u.origin,
      serviceId: String(input.serviceId),
      allowPrivate: input.allowPrivate === true
    };
    const identity = await peerRequest(peer, "api/nomad/distribution/identity");
    if (identity.serviceId !== peer.serviceId) fail(409, "peer_identity_changed");
    return this.distribution.mutate((s) => {
      s.peers.push(peer);
      return peer;
    });
  }
  async acceptance(actor: CatalogActor, input: any) {
    if (
      typeof input.sourceServiceId !== "string" ||
      typeof input.sourceInstanceId !== "string" ||
      !/^([a-f0-9]{64})$/.test(input.digest) ||
      typeof input.releaseId !== "string"
    )
      fail(400, "invalid_transfer_scope");
    const targetId = input.targetInstanceId;
    if (targetId) await this.distribution.catalog.checkPublish(actor, targetId);
    else if (!(await this.distribution.catalog.list(actor)).canCreate)
      fail(403, "creation_forbidden");
    const token = crypto.randomBytes(32).toString("hex");
    return this.distribution.mutate((s) => {
      s.acceptances = s.acceptances.filter((a) => a.expiresAt > Date.now());
      if (s.acceptances.length >= 100) fail(429, "acceptance_limit");
      const a = {
        id: crypto.randomUUID(),
        actorId: actor.id,
        tokenHash: sha(token),
        sourceServiceId: input.sourceServiceId,
        sourceInstanceId: input.sourceInstanceId,
        releaseId: input.releaseId,
        digest: input.digest,
        targetInstanceId: targetId ?? null,
        acceptEula: input.acceptEula === true,
        expected: input.expected ?? null,
        expiresAt: Date.now() + 86400000,
        cancelled: false
      };
      s.acceptances.push(a);
      return { ...a, token, tokenHash: undefined, destinationServiceId: s.serviceId };
    });
  }
  async accepted(token: string, lookup: (id: string) => CatalogActor | null) {
    const a = (await this.distribution.state()).acceptances.find((v) => v.tokenHash === sha(token));
    if (!a || a.cancelled || a.expiresAt < Date.now()) fail(403, "transfer_grant_invalid");
    const actor = lookup(a.actorId);
    if (!actor) fail(403, "transfer_owner_revoked");
    return { a, actor: actor! };
  }
  async revoke(actor: CatalogActor, id: string) {
    return this.distribution.mutate((s) => {
      const a = s.acceptances.find((v) => v.id === id);
      if (!a || (a.actorId !== actor.id && !actor.admin)) fail(403, "forbidden");
      a.cancelled = true;
      return { cancelled: true };
    });
  }
  async receiveUnlocked(token: string, input: any, lookup: (id: string) => CatalogActor | null) {
    const { a, actor } = await this.accepted(token, lookup);
    const manifest = validateManifest(input.manifest,this.distribution.limit());
    if (
      manifestDigest(manifest) !== a.digest ||
      input.sourceServiceId !== a.sourceServiceId ||
      input.sourceInstanceId !== a.sourceInstanceId ||
      input.releaseId !== a.releaseId
    )
      fail(403, "transfer_scope_mismatch");
    if (a.draftId) return this.distribution.status(actor, a.draftId);
    const profile = validateProfile(input.profile);
    const runtime =
      input.server && a.acceptEula
        ? await resolveServer(profile.mcVersion, { ...input.server, eulaAccepted: true })
        : undefined;
    let draft: PublicationDraft;
    if (a.targetInstanceId)
      draft = await this.distribution.create(actor, a.targetInstanceId, {
        manifest,
        expected: a.expected
      });
    else {
      if (!(await this.distribution.catalog.list(actor)).canCreate) fail(403, "creation_forbidden");
      draft = await this.distribution.mutate((s) => {
        const active=s.drafts.filter(d=>!d.result&&!d.cancelled&&d.expiresAt>Date.now());if(active.length>=32)fail(429,"publication_limit");if(active.reduce((n,d)=>n+d.manifest.files.reduce((sum,f)=>sum+f.size,0),0)+manifest.files.reduce((n,f)=>n+f.size,0)>this.distribution.limit()*2)fail(413,"publication_storage_quota");
        const d: PublicationDraft = {
          id: crypto.randomUUID(),
          actorId: actor.id,
          instanceId: "",
          expected: { revision: 0, baseReleaseId: null },
          manifest,
          digest: a.digest,
          createdAt: Date.now(),
          expiresAt: a.expiresAt,
          releaseId: crypto.randomUUID(),
          createTarget: {
            name: String(input.name ?? "Imported instance").slice(0, 120),
            profile,
            server: runtime?.settings,
            serverArtifact: runtime?.artifact
          }
        };
        s.drafts.push(d);
        return d;
      });
    }
    await this.distribution.mutate((s) => {
      const local = s.drafts.find((d) => d.id === draft.id)!;
      local.importProfile = profile;
      local.lineage = {
        serviceId: a.sourceServiceId,
        instanceId: a.sourceInstanceId,
        releaseId: a.releaseId,
        digest: a.digest
      };
      s.acceptances.find((v) => v.id === a.id).draftId = draft.id;
    });
    return this.distribution.status(actor, draft.id);
  }
  async receive(token: string, input: any, lookup: (id: string) => CatalogActor | null) {
    const p = this.receiving.then(() => this.receiveUnlocked(token, input, lookup));
    this.receiving = p.catch(() => undefined);
    return p;
  }
  async scoped(token: string, draftId: string, lookup: (id: string) => CatalogActor | null) {
    const { a, actor } = await this.accepted(token, lookup);
    if (a.draftId !== draftId) fail(403, "transfer_scope_mismatch");
    return actor;
  }
  async push(actor: CatalogActor, input: any, background = false) {
    await this.distribution.catalog.checkPublish(actor, input.instanceId);
    const r = await this.distribution.release(actor, input.instanceId, input.releaseId);
    if (!r.manifest || !r.manifestDigest) fail(409, "manifest_release_required");
    const s = await this.distribution.state(),
      found = s.peers.find((p) => p.id === input.peerId);
    if (!found) fail(403, "configured_peer_required");
    const peer = found!;
    if (typeof input.acceptanceToken !== "string" || !/^[a-f0-9]{64}$/.test(input.acceptanceToken))
      fail(400, "acceptance_token_required");
    const identity = await peerRequest(peer, "api/nomad/distribution/identity");
    if (identity.serviceId !== peer.serviceId) fail(409, "peer_identity_changed");
    const i = await this.distribution.instance(actor, input.instanceId);
    const job = await this.distribution.mutate((state) => {
      const prior = state.jobs.find(
        (j) =>
          j.actorId === actor.id &&
          j.peerId === peer.id &&
          j.instanceId === i.id &&
          j.releaseId === r.id &&
          j.acceptanceHash === sha(input.acceptanceToken)
      );
      if (prior) return prior;
      const j = {
        id: crypto.randomUUID(),
        actorId: actor.id,
        peerId: peer.id,
        instanceId: i.id,
        releaseId: r.id,
        acceptanceHash: sha(input.acceptanceToken),
        state: "pending",
        bytes: 0,
        at: Date.now()
      };
      state.jobs.push(j);
      state.jobs = state.jobs.slice(-200);
      return j;
    });
    if (job.state === "complete") return job;
    if(job.cancelled)fail(410,"transfer_cancelled");
    if (this.active.has(job.id)) return background ? job : this.active.get(job.id);
    const checkCancelled=async()=>{const current=(await this.distribution.state()).jobs.find(j=>j.id===job.id);if(current?.cancelled)fail(410,"transfer_cancelled")};
    const execute = async () => {
      const update = (value: any) =>
        this.distribution.mutate((state) =>
          Object.assign(
            state.jobs.find((j) => j.id === job.id),
            value
          )
        );
      try {
        await update({ state: "uploading", error: undefined });
        const draft = await peerRequest(
          peer,
          "api/nomad/distribution/receive",
          "POST",
          {
            manifest: r.manifest,
            profile: r.profile,
            server: r.server,
            name: i.name,
            sourceServiceId: s.serviceId,
            sourceInstanceId: i.id,
            releaseId: r.id
          },
          input.acceptanceToken
        );
        await update({ destinationDraftId: draft.id });
        let acknowledged=r.manifest!.files.reduce((sum,f)=>sum+f.size,0)-draft.missing.reduce((sum:number,f:any)=>sum+f.size-f.offset,0);await update({bytes:acknowledged});
        for (const f of draft.missing) {
          let offset = f.offset;
          const file = await fs.promises.open(this.distribution.blob(f.sha256), "r");
          try {
            do {
              await checkCancelled();
            await this.distribution.catalog.checkPublish(actor, i.id);
              const buffer = Buffer.alloc(Math.min(4 * 1024 ** 2, f.size - offset));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
              if (bytesRead !== buffer.length) fail(409, "source_blob_changed");
              const response = await peerRequest(
                peer,
                "api/nomad/distribution/receive/" +
                  draft.id +
                  "/blobs/" +
                  f.sha256 +
                  "?offset=" +
                  offset,
                "PUT",
                buffer,
                input.acceptanceToken
              );
              offset = response.offset;
              acknowledged+=buffer.length;await update({ bytes: acknowledged });
            } while (offset < f.size);
          } finally {
            await file.close();
          }
        }
        await checkCancelled();
        await this.distribution.catalog.checkPublish(actor, i.id);
        await this.distribution.mutate(state => {
          const current = state.jobs.find(j => j.id === job.id);
          if (current.cancelled) fail(410, "transfer_cancelled");
          current.state = "committing";
        });
        const result = await peerRequest(
          peer,
          "api/nomad/distribution/receive/" + draft.id + "/commit",
          "POST",
          {},
          input.acceptanceToken
        );
        return update({ state: "complete", result, completedAt: Date.now() });
      } catch (error) {
        await update({ state: error instanceof CatalogError&&error.code==="transfer_cancelled"?"cancelled":"failed", error: String(error).slice(0, 300) });
        throw error;
      }
    };
    const operation = execute().finally(() => this.active.delete(job.id));
    this.active.set(job.id, operation);
    if (background) {
      void operation.catch(() => undefined);
      return job;
    }
    return operation;
  }
  async cancel(actor:CatalogActor,id:string){return this.distribution.mutate(s=>{const j=s.jobs.find(v=>v.id===id);if(!j||j.actorId!==actor.id&&!actor.admin)fail(403,"forbidden");if(j.state==="complete")fail(409,"already_committed");if(j.state==="committing")fail(409,"commit_in_progress");j.cancelled=true;j.state="cancelled";return{id:j.id,state:j.state}})}
  async jobs(actor: CatalogActor) {
    return (await this.distribution.state()).jobs
      .map((j) =>
        ["uploading", "committing"].includes(j.state) && !this.active.has(j.id)
          ? {
              ...j,
              state: "interrupted",
              error: "Service restarted; submit the same scoped acceptance to resume"
            }
          : j
      )
      .filter((j) => j.actorId === actor.id || actor.admin)
      .map(({ acceptanceHash, ...j }) => j);
  }
}
