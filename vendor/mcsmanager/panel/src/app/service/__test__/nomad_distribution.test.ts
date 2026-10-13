import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { NomadDistribution } from "../nomad_distribution";
import { NomadCatalog } from "../nomad_catalog";
import { NomadFederation } from "../nomad_federation";
import { DEFAULT_PROFILE, type CatalogActor } from "../../../../../shared/nomad-catalog";
import {
  validateManifest,
  diffManifest,
  manifestDigest
} from "../../../../../shared/nomad-distribution";
const admin: CatalogActor = { id: "admin", name: "Admin", admin: true },
  member: CatalogActor = { id: "member", name: "Member", admin: false };
let directory: string, catalog: NomadCatalog, service: NomadDistribution;
let stored: Record<string, any>;
const content = Buffer.from("managed MOD bytes"),
  hash = crypto.createHash("sha256").update(content).digest("hex");
const manifest = {
  schema: 1 as const,
  files: [
    {
      path: "mods/example.jar",
      size: content.length,
      sha256: hash,
      side: "both" as const,
      ownership: "managed" as const
    }
  ]
};
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nc-distribution-"));
  stored = {};
  const storage: any = {
    load: async (c: string, _class: any, id: string) =>
      stored[c + "/" + id] ? structuredClone(stored[c + "/" + id]) : null,
    store: async (c: string, id: string, v: any) => {
      stored[c + "/" + id] = structuredClone(v);
    }
  };
  catalog = new NomadCatalog(() => storage);
  service = new NomadDistribution(
    () => storage,
    catalog,
    path.join(directory, "distribution"),
    () => 1024 * 1024
  );
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const instance = () =>
  catalog.create(admin, {
    name: "Friends",
    description: "",
    profile: { ...DEFAULT_PROFILE, mcVersion: "1.20.1", loader: "vanilla" }
  });
async function draft(i: any) {
  return service.create(admin, i.id, {
    manifest,
    expected: { revision: i.revision, baseReleaseId: i.releases?.slice(-1)[0]?.id ?? null }
  });
}
describe("manifest distribution", () => {
  it("rejects inconsistent sizes for reused content hashes", async () => {
    expect(() => validateManifest({schema: 1, files: [manifest.files[0], {...manifest.files[0], path: "mods/alias.jar", size: content.length + 1}]})).toThrow("hash_size");
    const i = await instance(), first = await draft(i);
    await service.chunk(admin, first.id, hash, 0, Readable.from([content]));
    const second = await service.create(admin, i.id, {manifest: {schema: 1, files: [{...manifest.files[0], size: content.length + 1}]}, expected: first.expected});
    await expect(service.chunk(admin, second.id, hash, 0, Readable.from([content]))).rejects.toMatchObject({code: "blob_size_mismatch"});
  });

  it("persists service identity across service instances", async () => {
    const a = await service.identity(),
      b = await new NomadDistribution(
        (service as any).storage,
        catalog,
        path.join(directory, "distribution")
      ).identity();
    expect(a.serviceId).toBe(b.serviceId);
  });
  it("rejects aliases, traversal, quotas and private roots", () => {
    expect(() =>
      validateManifest({
        schema: 1,
        files: [...manifest.files, { ...manifest.files[0], path: "mods/EXAMPLE.jar" }]
      })
    ).toThrow("duplicate");
    for (const p of [
      "mods/../a",
      "mods/a\\b",
      "mods/con.jar",
      "mods/a.",
      "accounts.json",
      "saves/world.dat"
    ])
      expect(() =>
        validateManifest({ schema: 1, files: [{ ...manifest.files[0], path: p }] })
      ).toThrow();
    expect(() => validateManifest(manifest, 1)).toThrow("quota");
  });
  it("does not publish incomplete or corrupt data", async () => {
    const i = await instance(),
      d = await draft(i);
    await expect(service.commit(admin, d.id)).rejects.toMatchObject({
      code: "publication_incomplete"
    });
    await expect(
      service.chunk(admin, d.id, hash, 0, Readable.from([Buffer.alloc(content.length)]))
    ).rejects.toMatchObject({ code: "blob_hash_mismatch" });
    expect((await service.status(admin, d.id)).missing[0].offset).toBe(0);
    expect((await service.instance(admin, i.id)).releases).toHaveLength(0);
  });
  it("resumes an upload, verifies and commits only one immutable release", async () => {
    const i = await instance(),
      d = await draft(i);
    await service.chunk(admin, d.id, hash, 0, Readable.from([content.subarray(0, 5)]));
    expect((await service.status(admin, d.id)).missing[0].offset).toBe(5);
    await expect(
      service.chunk(admin, d.id, hash, 0, Readable.from([content]))
    ).rejects.toMatchObject({ code: "upload_offset_conflict" });
    await service.chunk(admin, d.id, hash, 5, Readable.from([content.subarray(5)]));
    const r = await service.commit(admin, d.id);
    expect(r.manifestDigest).toBe(manifestDigest(manifest));
    expect((await service.commit(admin, d.id)).id).toBe(r.id);
    expect(await fs.readFile(await service.authorizedBlob(admin, i.id, r.id, hash))).toEqual(
      content
    );
  });
  it("prevents a second publisher from overwriting the first", async () => {
    const i = await instance(),
      a = await draft(i),
      b = await draft(i);
    await service.chunk(admin, a.id, hash, 0, Readable.from([content]));
    await service.commit(admin, a.id);
    await expect(service.commit(admin, b.id)).rejects.toMatchObject({
      code: "publication_base_conflict"
    });
    expect((await service.instance(admin, i.id)).releases).toHaveLength(1);
  });
  it("requires both instance permissions and rechecks revocation at commit", async () => {
    const i = await instance();
    await catalog.grants(
      admin,
      i.id,
      [
        {
          userId: member.id,
          scope: "instance",
          permissions: ["instance.read", "save.read", "mods.manage"],
          hosting: false
        }
      ],
      () => true
    );
    await expect(
      service.create(member, i.id, { manifest, expected: { revision: 2, baseReleaseId: null } })
    ).rejects.toMatchObject({ code: "forbidden" });
    const latest = await service.instance(admin, i.id),
      d = await draft(latest);
    await service.chunk(admin, d.id, hash, 0, Readable.from([content]));
    await expect(service.status(member, d.id)).rejects.toMatchObject({
      code: "publication_forbidden"
    });
    await service.cancel(admin, d.id);
    await expect(service.commit(admin, d.id)).rejects.toMatchObject({
      code: "publication_expired"
    });
  });
  it("detects local conflicts without marking additional files for deletion", () => {
    const next = { schema: 1 as const, files: [] };
    const diff = diffManifest(manifest, next, {
      "mods/example.jar": "locally-edited",
      "shaderpacks/personal.zip": "x"
    });
    expect(diff).toEqual([
      {
        path: "mods/example.jar",
        operation: "remove",
        conflict: true,
        current: "locally-edited",
        before: hash,
        next: undefined
      }
    ]);
  });
  it("imports an authorized independent instance only after a complete transfer", async () => {
    const federation = new NomadFederation(service),
      grant = await federation.acceptance(admin, {
        sourceServiceId: "source",
        sourceInstanceId: "source-instance",
        releaseId: "release",
        digest: manifestDigest(manifest)
      }),
      lookup = () => admin;
    const received = await federation.receive(
      grant.token,
      {
        sourceServiceId: "source",
        sourceInstanceId: "source-instance",
        releaseId: "release",
        manifest,
        profile: { ...DEFAULT_PROFILE, mcVersion: "1.20.1" },
        name: "Copied"
      },
      lookup
    );
    expect((await catalog.list(admin)).instances).toHaveLength(0);
    await service.chunk(admin, received.id, hash, 0, Readable.from([content]));
    const result = await service.commit(admin, received.id);
    expect(result.lineage?.serviceId).toBe("source");
    const all = (await catalog.list(admin)).instances;
    expect(all).toHaveLength(1);
    expect(all[0].ownerId).toBe(admin.id);
    expect(all[0].grants).toEqual([]);
    expect(
      (
        await federation.receive(
          grant.token,
          {
            sourceServiceId: "source",
            sourceInstanceId: "source-instance",
            releaseId: "release",
            manifest,
            profile: DEFAULT_PROFILE
          },
          lookup
        )
      ).id
    ).toBe(received.id);
    await service.commit(admin, received.id);
    expect((await catalog.list(admin)).instances).toHaveLength(1);
  });
  it("enforces peer scope and cancellation before receiving or committing", async () => {
    const federation = new NomadFederation(service),
      grant = await federation.acceptance(admin, {
        sourceServiceId: "source",
        sourceInstanceId: "instance",
        releaseId: "release",
        digest: manifestDigest(manifest)
      });
    await expect(
      federation.receive(
        grant.token,
        {
          sourceServiceId: "wrong",
          sourceInstanceId: "instance",
          releaseId: "release",
          manifest,
          profile: DEFAULT_PROFILE
        },
        () => admin
      )
    ).rejects.toMatchObject({ code: "transfer_scope_mismatch" });
    await federation.revoke(admin, grant.id);
    await expect(federation.accepted(grant.token, () => admin)).rejects.toMatchObject({
      code: "transfer_grant_invalid"
    });
  });
 it('scope cancellation and quota restrictions survive durable receiver metadata',async()=>{const federation=new NomadFederation(service);await service.mutate(state=>{state.jobs.push({id:'job',actorId:admin.id,state:'uploading'})});await expect(federation.cancel(member,'job')).rejects.toMatchObject({code:'forbidden'});await federation.cancel(admin,'job');expect((await federation.jobs(admin))[0].state).toBe('cancelled');await service.mutate(state=>{state.jobs[0].state='committing'});await expect(federation.cancel(admin,'job')).rejects.toMatchObject({code:'commit_in_progress'});await service.mutate(state=>{state.jobs[0].state='complete'});await expect(federation.cancel(admin,'job')).rejects.toMatchObject({code:'already_committed'});const huge={schema:1 as const,files:[{...manifest.files[0],size:2*1024*1024}]};const grant=await federation.acceptance(admin,{sourceServiceId:'source',sourceInstanceId:'instance',releaseId:'release',digest:manifestDigest(huge)});await expect(federation.receive(grant.token,{manifest:huge,sourceServiceId:'source',sourceInstanceId:'instance',releaseId:'release',profile:DEFAULT_PROFILE},()=>admin)).rejects.toThrow('quota');});

});
