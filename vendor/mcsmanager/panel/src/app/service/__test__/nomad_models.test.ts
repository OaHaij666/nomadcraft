import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { NomadModels } from "../nomad_models";
import { NomadBots } from "../nomad_bots";
import { NomadCatalog } from "../nomad_catalog";
import { DEFAULT_PROFILE, DEFAULT_RULES } from "../../../../../shared/nomad-catalog";
const owner = { id: "owner", name: "Owner", admin: true },
  member = { id: "member", name: "Member", admin: false },
  other = { id: "other", name: "Other", admin: false };
let models: NomadModels,
  bots: NomadBots,
  catalog: NomadCatalog,
  instanceId: string,
  saveId: string,
  directory: string;
const bytes = Buffer.from("ysm model fixture"),
  hash = crypto.createHash("sha256").update(bytes).digest("hex");
const payload = () => ({
  instanceId,
  saveId,
  name: "Test YSM",
  manifest: {
    schema: 1,
    files: [
      {
        path: "config/yes_steve_model/custom/test.ysm",
        size: bytes.length,
        sha256: hash,
        side: "both",
        ownership: "managed"
      }
    ]
  }
});
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nc-model-review-"));
  const records: Record<string, any> = {};
  const storage: any = {
    load: async (c: string, _ctor: any, id: string) =>
      records[c + "/" + id] ? structuredClone(records[c + "/" + id]) : null,
    store: async (c: string, id: string, data: any) => {
      records[c + "/" + id] = structuredClone(data);
    }
  };
  catalog = new NomadCatalog(() => storage);
  models = new NomadModels(() => storage, catalog, directory);
  bots = new NomadBots(() => storage, catalog, models);
  instanceId = (
    await catalog.create(owner, {
      name: "World",
      description: "",
      profile: { ...DEFAULT_PROFILE, mcVersion: "1.21.1" }
    })
  ).id;
  saveId = (
    await catalog.save(owner, instanceId, null, {
      name: "Save",
      description: "",
      rules: { ...DEFAULT_RULES }
    })
  ).id;
  await catalog.grants(
    owner,
    instanceId,
    [member, other].map((user) => ({
      userId: user.id,
      scope: "instance",
      permissions: ["instance.read", "save.read"],
      hosting: false
    })),
    () => true
  );
});
afterEach(() => fs.rm(directory, { recursive: true, force: true }));
it("staged resources never deploy or reach other players before reviewer approval", async () => {
  const a = await models.create(member, payload());
  expect(await models.approved(instanceId, saveId)).toEqual([]);
  await models.blob(member, a.id, hash, Readable.from(bytes));
  const pending = await models.commit(member, a.id);
  expect(pending.status).toBe("pending");
  await expect(models.read(other, a.id, hash)).rejects.toMatchObject({ status: 403 });
  await expect(
    models.review(member, a.id, { revision: pending.revision, decision: "approve", reason: "" })
  ).rejects.toMatchObject({ status: 403 });
  await models.review(owner, a.id, {
    revision: pending.revision,
    decision: "approve",
    reason: "Reviewed"
  });
  expect((await models.approved(instanceId, saveId)).length).toBe(1);
  expect(await fs.readFile(await models.read(other, a.id, hash))).toEqual(bytes);
});
it("rejects undeclared paths, hash mismatches and incomplete uploads", async () => {
  const bad = payload();
  bad.manifest.files[0].path = "config/server.properties";
  await expect(models.create(member, bad)).rejects.toMatchObject({ status: 400 });
  const a = await models.create(member, payload());
  await expect(
    models.blob(member, a.id, hash, Readable.from(Buffer.alloc(bytes.length)))
  ).rejects.toMatchObject({ status: 400 });
  await expect(models.commit(member, a.id)).rejects.toMatchObject({ status: 409 });
  expect(await fs.readdir(path.join(directory, a.id))).toEqual([]);
});
it("bot admission cannot approve resources still pending or rejected", async () => {
  const a = await models.create(member, payload());
  await models.blob(member, a.id, hash, Readable.from(bytes));
  const pending = await models.commit(member, a.id);
  const bot = await bots.create(member, {
    instanceId,
    saveId,
    scope: "private",
    name: "ModelBot",
    access: { mode: "whitelist", users: [] },
    resourceApplications: [a.id]
  });
  await expect(
    bots.review(owner, bot.id, { revision: 1, decision: "approve", reason: "" })
  ).rejects.toMatchObject({ status: 409 });
  await models.review(owner, a.id, { revision: pending.revision, decision: "approve", reason: "" });
  expect(
    (await bots.review(owner, bot.id, { revision: 1, decision: "approve", reason: "" })).admission
  ).toBe("approved");
});
it("rejected model never becomes executable or downloadable by an unrelated member", async () => {
  const a = await models.create(member, payload());
  await models.blob(member, a.id, hash, Readable.from(bytes));
  const pending = await models.commit(member, a.id);
  await models.review(owner, a.id, {
    revision: pending.revision,
    decision: "reject",
    reason: "Not allowed"
  });
  expect(await models.approved(instanceId, saveId)).toEqual([]);
  await expect(models.approvedBlob(instanceId, saveId, a.id, hash)).rejects.toMatchObject({
    status: 403
  });
});
