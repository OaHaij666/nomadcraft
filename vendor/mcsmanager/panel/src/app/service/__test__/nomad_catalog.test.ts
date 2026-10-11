import { beforeEach, describe, expect, it } from "vitest";
import { NomadCatalog, permissionsFor } from "../nomad_catalog";
import {
  DEFAULT_PROFILE,
  DEFAULT_RULES,
  type PublishedRelease,
  type CatalogActor
} from "../../../../../shared/nomad-catalog";
const admin: CatalogActor = { id: "admin", name: "Admin", admin: true };
const user: CatalogActor = { id: "player", name: "Player", admin: false };
const other: CatalogActor = { id: "other", name: "Other", admin: false };
let stored: any;
let catalog: NomadCatalog;
let failWrite = false;
const payload = () => ({
  name: "Fabric group",
  description: "",
  profile: { ...DEFAULT_PROFILE, mcVersion: "1.20.1", loader: "fabric" }
});
const savePayload = (name: string) => ({ name, description: "", rules: { ...DEFAULT_RULES } });
beforeEach(() => {
  stored = null;
  failWrite = false;
  catalog = new NomadCatalog(() => ({
    load: async () => (stored ? structuredClone(stored) : null),
    store: async (_c, _id, data) => {
      if (failWrite) throw new Error("disk failure");
      stored = structuredClone(data);
    },
    list: async () => [],
    delete: async () => {}
  }));
});
describe("logical instance catalog and authorization", () => {
  it("requires creation authority and assigns owner from authenticated identity", async () => {
    await expect(catalog.create(user, payload())).rejects.toMatchObject({ status: 403 });
    await catalog.creators(admin, [user.id], () => true);
    const instance = await catalog.create(user, { ...payload(), ownerId: other.id });
    expect(instance.ownerId).toBe(user.id);
    await expect(catalog.creators(user, [other.id], () => true)).rejects.toMatchObject({
      status: 403
    });
    expect((await catalog.list(other)).instances).toEqual([]);
  });
  it("supports multiple independent saves and serializes competing room requests", async () => {
    const instance = await catalog.create(admin, payload());
    const a = await catalog.save(admin, instance.id, null, savePayload("A"));
    const b = await catalog.save(admin, instance.id, null, savePayload("B"));
    expect(a.id).not.toBe(b.id);
    const requests = await Promise.allSettled([
      catalog.room(admin, instance.id, a.id, { name: "Room A" }, true),
      catalog.room(admin, instance.id, a.id, { name: "Duplicate" }, true)
    ]);
    expect(requests.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (requests.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ status: 409, code: "room_exists" });
    expect(
      (await catalog.list(admin)).instances[0].saves.find((s) => s.id === b.id)?.room
    ).toBeNull();
  });
  it("filters scoped saves and denies actions on a sibling save", async () => {
    const i = await catalog.create(admin, payload());
    const a = await catalog.save(admin, i.id, null, savePayload("Secret A"));
    const b = await catalog.save(admin, i.id, null, savePayload("Secret B"));
    await catalog.grants(
      admin,
      i.id,
      [
        {
          userId: user.id,
          scope: a.id,
          permissions: ["save.read", "save.update", "room.manage"],
          hosting: false
        }
      ],
      () => true
    );
    const response = await catalog.list(user);
    expect(response.instances[0].saves.map((s) => s.id)).toEqual([a.id]);
    expect(JSON.stringify(response)).not.toContain("Secret B");
    expect(response.instances[0].savePermissions[b.id]).toBeUndefined();
    await expect(catalog.save(user, i.id, b.id, savePayload("Changed"))).rejects.toMatchObject({
      status: 403
    });
    await expect(catalog.save(user, i.id, null, savePayload("New"))).rejects.toMatchObject({
      status: 403
    });
  });
  it("hosting approval never grants management, membership changes or OP", async () => {
    const i = await catalog.create(admin, payload());
    const save = await catalog.save(admin, i.id, null, savePayload("A"));
    await catalog.grants(
      admin,
      i.id,
      [{ userId: user.id, scope: save.id, permissions: ["save.read"], hosting: true }],
      () => true
    );
    expect((await catalog.list(user)).instances[0].hostingScopes).toEqual([save.id]);
    expect(permissionsFor(stored.instances[0], user, save.id)).toEqual(["save.read"]);
    await expect(catalog.room(user, i.id, save.id, { name: "Room" }, true)).rejects.toMatchObject({
      status: 403
    });
    await expect(catalog.grants(user, i.id, [], () => true)).rejects.toMatchObject({ status: 403 });
    await expect(catalog.players(user, i.id, save.id, [])).rejects.toMatchObject({ status: 403 });
  });
  it("revocation takes effect and persistence survives service reconstruction", async () => {
    const i = await catalog.create(admin, payload());
    await catalog.save(admin, i.id, null, savePayload("A"));
    await catalog.grants(
      admin,
      i.id,
      [
        {
          userId: user.id,
          scope: "instance",
          permissions: ["instance.read", "save.read"],
          hosting: false
        }
      ],
      () => true
    );
    expect((await catalog.list(user)).instances).toHaveLength(1);
    await catalog.grants(admin, i.id, [], () => true);
    expect((await catalog.list(user)).instances).toHaveLength(0);
    const again = new NomadCatalog((catalog as any).storage);
    expect((await again.list(admin)).instances[0].name).toBe("Fabric group");
  });
  it("locks version and seed identity and requires rooms closed before changes", async () => {
    const i = await catalog.create(admin, payload());
    const save = await catalog.save(admin, i.id, null, savePayload("A"));
    await expect(
      catalog.update(admin, i.id, {
        ...payload(),
        profile: { ...payload().profile, mcVersion: "1.21" }
      })
    ).rejects.toMatchObject({ code: "version_locked" });
    await expect(
      catalog.save(admin, i.id, save.id, {
        ...savePayload("A"),
        rules: { ...DEFAULT_RULES, seed: "changed" }
      })
    ).rejects.toMatchObject({ code: "seed_locked" });
    await catalog.room(admin, i.id, save.id, { name: "Room" }, true);
    await catalog.room(admin, i.id, save.id, { name: "Room", desiredState: "open" }, false);
    await expect(catalog.deleteSave(admin, i.id, save.id)).rejects.toMatchObject({
      code: "close_rooms_first"
    });
    await expect(catalog.mods(admin, i.id, [])).rejects.toMatchObject({
      code: "close_rooms_first"
    });
    const room = (await catalog.list(admin)).instances[0].saves[0].room;
    expect(room?.desiredState).toBe("open");
    expect(room).not.toHaveProperty("running");
  });
  it("clone copies profile and manifest but never saves or grants", async () => {
    const i = await catalog.create(admin, payload());
    await catalog.save(admin, i.id, null, savePayload("A"));
    await catalog.mods(admin, i.id, [
      { name: "Server mod", version: "1", file: "mod.jar", sha256: "", side: "server" }
    ]);
    const clone = await catalog.clone(admin, i.id);
    expect(clone.id).not.toBe(i.id);
    expect(clone.profile).toEqual(i.profile);
    expect(clone.mods).toHaveLength(1);
    expect(clone.saves).toEqual([]);
    expect(clone.grants).toEqual([]);
  });
  it("validates member scopes, mod paths, hashes and player identities", async () => {
    const i = await catalog.create(admin, payload());
    const save = await catalog.save(admin, i.id, null, savePayload("A"));
    await expect(
      catalog.grants(
        admin,
        i.id,
        [
          {
            userId: user.id,
            scope: save.id,
            permissions: ["save.read", "instance.update"],
            hosting: false
          }
        ],
        () => true
      )
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      catalog.grants(
        admin,
        i.id,
        [{ userId: user.id, scope: "instance", permissions: ["save.read"], hosting: false }],
        () => false
      )
    ).rejects.toMatchObject({ code: "unknown_user" });
    await expect(
      catalog.mods(admin, i.id, [
        { name: "Bad", version: "", file: "../bad.jar", sha256: "", side: "server" }
      ])
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      catalog.mods(admin, i.id, [
        { name: "Bad", version: "", file: "bad.jar", sha256: "no", side: "server" }
      ])
    ).rejects.toMatchObject({ code: "invalid_hash" });
    await expect(
      catalog.players(admin, i.id, save.id, [
        { uuid: "not-a-uuid", name: "player", access: "allowed", opLevel: 4 }
      ])
    ).rejects.toMatchObject({ code: "invalid_player_uuid" });
  });
  it("keeps failed persistence out of later reads and recovers the mutation queue", async () => {
    const i = await catalog.create(admin, payload());
    failWrite = true;
    await expect(catalog.save(admin, i.id, null, savePayload("Uncommitted"))).rejects.toThrow(
      "disk failure"
    );
    failWrite = false;
    expect((await catalog.list(admin)).instances[0].saves).toEqual([]);
    await catalog.save(admin, i.id, null, savePayload("Committed"));
    expect((await catalog.list(admin)).instances[0].saves).toHaveLength(1);
  });
  it("deleting a save removes scoped grants and deleting populated instances is refused", async () => {
    const i = await catalog.create(admin, payload());
    const save = await catalog.save(admin, i.id, null, savePayload("A"));
    await catalog.grants(
      admin,
      i.id,
      [{ userId: user.id, scope: save.id, permissions: ["save.read"], hosting: true }],
      () => true
    );
    await expect(catalog.delete(admin, i.id)).rejects.toMatchObject({ code: "instance_has_saves" });
    await catalog.deleteSave(admin, i.id, save.id);
    expect((await catalog.list(admin)).instances[0].grants).toEqual([]);
    await catalog.delete(admin, i.id);
    expect((await catalog.list(admin)).instances).toEqual([]);
  });
});

const release = (id: string): PublishedRelease => ({id, format: "modrinth", source: "upload", fileName: id + ".mrpack", sha256: "a".repeat(64), size: 100, profile: {...payload().profile, loader: "fabric", packRevision: id}, publishedAt: 1, publishedBy: admin.id, fileCount: 1});
describe("published release authorization and pinning", () => {
  it("pins new saves without upgrading existing saves on publication", async () => {
    const instance = await catalog.create(admin, payload(), release("v1"));
    const first = await catalog.save(admin, instance.id, null, savePayload("A"));
    expect(first.releaseId).toBe("v1");
    await catalog.publish(admin, instance.id, release("v2"));
    const second = await catalog.save(admin, instance.id, null, savePayload("B"));
    const view = (await catalog.list(admin)).instances[0];
    expect(view.saves.find(s => s.id === first.id)?.releaseId).toBe("v1");
    expect(second.releaseId).toBe("v2");
  });
  it("exposes only pinned releases to a save-scoped member and revokes downloads", async () => {
    const instance = await catalog.create(admin, payload(), release("v1"));
    const save = await catalog.save(admin, instance.id, null, savePayload("A"));
    await catalog.publish(admin, instance.id, release("v2"));
    await catalog.grants(admin, instance.id, [{userId: user.id, scope: save.id, permissions: ["save.read"], hosting: true}], () => true);
    expect((await catalog.list(user)).instances[0].releases?.map(r => r.id)).toEqual(["v1"]);
    await expect(catalog.release(user, instance.id, "v2")).rejects.toMatchObject({status: 404});
    await expect(catalog.publish(user, instance.id, release("v3"))).rejects.toMatchObject({status: 403});
    await expect(catalog.bindRelease(user, instance.id, save.id, "v2")).rejects.toMatchObject({status: 403});
    await catalog.grants(admin, instance.id, [], () => true);
    await expect(catalog.release(user, instance.id, "v1")).rejects.toMatchObject({status: 403});
  });
  it("requires closed rooms and rejects a different Minecraft base", async () => {
    const instance = await catalog.create(admin, payload(), release("v1"));
    const save = await catalog.save(admin, instance.id, null, savePayload("A"));
    await catalog.publish(admin, instance.id, release("v2"));
    await catalog.room(admin, instance.id, save.id, {name: "A"}, true);
    await catalog.room(admin, instance.id, save.id, {name: "A", desiredState: "open"}, false);
    await expect(catalog.bindRelease(admin, instance.id, save.id, "v2")).rejects.toMatchObject({status: 409});
    const bad = release("bad"); bad.profile.mcVersion = "1.21.1";
    await expect(catalog.publish(admin, instance.id, bad)).rejects.toMatchObject({code: "version_locked"});
    await catalog.room(admin, instance.id, save.id, {name: "A", desiredState: "closed"}, false);
    expect((await catalog.bindRelease(admin, instance.id, save.id, "v2")).releaseId).toBe("v2");
  });
});
