import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import * as yazl from "yazl";
import { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_PROFILE, DEFAULT_RULES } from "../../shared/nomad-catalog";
// Real authenticated panel, isolated data and an ephemeral port. No auth bypass.
const panelRoot = path.resolve(__dirname, "..");
const password = "Catalog.Test123";
let workDir = "";
let base = "";
let proc: ChildProcess;
let serverErrors = "";
let port = 0;
interface Session {
  cookie: string;
  token: string;
}
let admin: Session;
let player: Session;
let userId = "";
let instanceId = "";
let firstSave = "";
let secondSave = "";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(method: string, route: string, body?: unknown, session?: Session) {
  await delay(145);
  const response = await fetch(base + "/api" + route + (session ? (route.includes("?") ? "&" : "?") + "token=" + session.token : ""), {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(session ? { Cookie: session.cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data: data.data ?? data, response };
}
async function login(name: string): Promise<Session> {
  const r = await call("POST", "/auth/login", { username: name, password });
  expect(r.status).toBe(200);
  return {
    cookie: r.response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    token: r.data
  };
}
async function start() {
  proc = spawn(process.execPath, [path.join(panelRoot, "production/app.js")], {
    cwd: workDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout?.on("data", data => { serverErrors = (serverErrors + data.toString().split("\n").filter((line: string) => /error|Error|nomad_catalog|nomad_packages|koaBody|TypeError/.test(line) && !/Token|password|secret/i.test(line)).join("\n")).slice(-4000); });
  proc.stderr?.on("data", data => { serverErrors = (serverErrors + data.toString()).slice(-4000); });
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + "/api/auth/status");
      if (r.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error("isolated panel did not start");
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill();
  await Promise.race([exited, delay(4000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}
beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomad-catalog-http-"));
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  base = "http://127.0.0.1:" + port;
  await fs.mkdir(path.join(workDir, "data/SystemConfig"), { recursive: true });
  await fs.writeFile(
    path.join(workDir, "data/SystemConfig/config.json"),
    JSON.stringify({ httpPort: port, httpIp: "127.0.0.1", language: "en_us", loginCheckIp: false })
  );
  await fs.copyFile(
    path.join(panelRoot, "data/market_cache.json"),
    path.join(workDir, "data/market_cache.json")
  );
  await start();
  const installed = await call("POST", "/auth/install", { username: "catalog_admin", password });
  expect(installed.status).toBe(200);
  admin = await login("catalog_admin");
  const user = await call(
    "POST",
    "/auth",
    { username: "catalog_player", password, permission: 1 },
    admin
  );
  expect(user.status).toBe(200);
  userId = user.data.uuid;
  player = await login("catalog_player");
}, 30000);
afterAll(async () => {
  await stop();
  if (
    workDir &&
    path.dirname(path.resolve(workDir)) === path.resolve(os.tmpdir()) &&
    path.basename(workDir).startsWith("nomad-catalog-http-")
  )
    await fs.rm(workDir, { recursive: true, force: true });
});
describe("catalog authenticated HTTP integration", () => {
  it("denies anonymous requests and unauthorized creation", async () => {
    expect((await call("GET", "/nomad/catalog/")).status).toBe(403);
    expect((await call("POST", "/nomad/catalog/instances", { name: "Bad" }, player)).status).toBe(
      403
    );
  });
  it("creates a logical version without a daemon and grants creation explicitly", async () => {
    const input = {
      name: "HTTP Fabric",
      description: "",
      profile: { ...DEFAULT_PROFILE, mcVersion: "1.20.1", loader: "fabric" }
    };
    const result = await call("POST", "/nomad/catalog/instances", input, admin);
    expect(result.status).toBe(200);
    instanceId = result.data.id;
    expect(
      (await call("PUT", "/nomad/catalog/creators", { userIds: [userId] }, admin)).status
    ).toBe(200);
    const created = await call(
      "POST",
      "/nomad/catalog/instances",
      { ...input, name: "Player owned", ownerId: "forged" },
      player
    );
    expect(created.status).toBe(200);
    const listing = await call("GET", "/nomad/catalog/", undefined, player);
    expect(listing.data.instances[0].ownerId).toBe(userId);
  });
  it("supports multiple saves and rejects a second room through real HTTP", async () => {
    for (const name of ["Save A", "Save B"]) {
      const r = await call(
        "POST",
        "/nomad/catalog/instances/" + instanceId + "/saves",
        { name, description: "", rules: DEFAULT_RULES },
        admin
      );
      expect(r.status).toBe(200);
      if (!firstSave) firstSave = r.data.id;
      else secondSave = r.data.id;
    }
    const room = "/nomad/catalog/instances/" + instanceId + "/saves/" + firstSave + "/room";
    const results = await Promise.all([
      call("POST", room, { name: "One" }, admin),
      call("POST", room, { name: "Two" }, admin)
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("filters scoped save access, blocks sibling edits and prevents hosting escalation", async () => {
    const grants = [{ userId, scope: firstSave, permissions: ["save.read"], hosting: true }];
    expect(
      (await call("PUT", "/nomad/catalog/instances/" + instanceId + "/grants", { grants }, admin))
        .status
    ).toBe(200);
    const listing = await call("GET", "/nomad/catalog/", undefined, player);
    const view = listing.data.instances.find((i: any) => i.id === instanceId);
    expect(view.saves.map((s: any) => s.id)).toEqual([firstSave]);
    expect(view.hostingScopes).toEqual([firstSave]);
    expect(JSON.stringify(view)).not.toContain("Save B");
    expect(
      (
        await call(
          "PUT",
          "/nomad/catalog/instances/" + instanceId + "/saves/" + secondSave,
          { name: "Attack", description: "", rules: DEFAULT_RULES },
          player
        )
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/nomad/catalog/instances/" + instanceId + "/grants",
          { grants: [] },
          player
        )
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/nomad/catalog/instances/" + instanceId + "/saves/" + firstSave + "/players",
          { players: [] },
          player
        )
      ).status
    ).toBe(403);
  });
  it("revocation removes access immediately", async () => {
    expect(
      (
        await call(
          "PUT",
          "/nomad/catalog/instances/" + instanceId + "/grants",
          { grants: [] },
          admin
        )
      ).status
    ).toBe(200);
    const listing = await call("GET", "/nomad/catalog/", undefined, player);
    expect(listing.data.instances.some((i: any) => i.id === instanceId)).toBe(false);
  });
  it("imports immutable packs, scopes download access and enforces revocation through HTTP", async () => {
    const pack = async (revision: string) => {
      const zip = new yazl.ZipFile(), chunks: Buffer[] = [];
      zip.addBuffer(Buffer.from(JSON.stringify({formatVersion: 1, game: "minecraft", name: "Cloud pack", versionId: revision, files: [], dependencies: {minecraft: "1.20.1"}})), "modrinth.index.json");
      const completed = new Promise<Buffer>((resolve, reject) => {zip.outputStream.on("data", c => chunks.push(c)); zip.outputStream.on("error", reject); zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));});
      zip.end(); return completed;
    };
    const upload = async (bytes: Buffer, session: Session, id?: string) => {
      await delay(145); const form = new FormData(); form.append("package", new Blob([bytes]), "cloud.mrpack"); if (id) form.append("instanceId", id);
      const response = await fetch(base + "/api/nomad/catalog/import?token=" + session.token + (id ? "&instanceId=" + id : ""), {method: "POST", headers: {Cookie: session.cookie, "X-Requested-With": "XMLHttpRequest"}, body: form});
      const body = await response.text();
      try { return {status: response.status, data: JSON.parse(body).data}; } catch { throw new Error("Upload HTTP " + response.status + ": " + body + " / " + serverErrors); }
    };
    const bytes = await pack("v1");
    const imported = await upload(bytes, admin); expect(imported.status).toBe(200); const cloudId = imported.data.id;
    const saved = await call("POST", "/nomad/catalog/instances/" + cloudId + "/saves", {name: "Cloud save", description: "", rules: DEFAULT_RULES}, admin); expect(saved.status).toBe(200);
    const pinned = saved.data.releaseId;
    const published = await upload(await pack("v2"), admin, cloudId); expect(published.status).toBe(200); const nextId = published.data.id;
    await call("PUT", "/nomad/catalog/instances/" + cloudId + "/grants", {grants: [{userId, scope: saved.data.id, permissions: ["save.read"], hosting: true}]}, admin);
    player = await login("catalog_player");
    const listing = await call("GET", "/nomad/catalog/", undefined, player);
    expect(listing.data.instances.find((i: any) => i.id === cloudId).releases.map((r: any) => r.id)).toEqual([pinned]);
    const download = async (id: string, session?: Session) => {
      await delay(145); return fetch(base + "/api/nomad/catalog/instances/" + cloudId + "/releases/" + id + "/package" + (session ? "?token=" + session.token : ""), {headers: {"X-Requested-With": "XMLHttpRequest", ...(session ? {Cookie: session.cookie} : {})}});
    };
    expect((await download(pinned)).status).toBe(403);
    const allowed = await download(pinned, player); expect(allowed.status).toBe(200);
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes);
    expect(allowed.headers.get("x-nomad-sha256")).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect((await download(nextId, player)).status).toBe(404);
    expect((await upload(await pack("v3"), player, cloudId)).status).toBe(403);
    const probe = path.resolve(panelRoot, "../../../launchers/pcl/tests/bin/Release/net10.0/CloudClientProbe.dll");
    if (await fs.stat(probe).catch(() => null)) {
      // Invoke exactly the C# cloud client used by the WPF launcher against the real panel.
      await delay(1000);
      const output = spawnSync("dotnet", [probe, "http"], {windowsHide: true, encoding: "utf8", env: {...process.env, NOMAD_TEST_URL: base, NOMAD_TEST_USER: "catalog_player", NOMAD_TEST_PASSWORD: password, NOMAD_TEST_INSTANCE: cloudId}});
      expect(output.status, output.stdout + output.stderr).toBe(0);
    }
    await call("PUT", "/nomad/catalog/instances/" + cloudId + "/grants", {grants: []}, admin);
    expect((await download(pinned, player)).status).toBe(403);
    const state = (await call("GET", "/nomad/catalog/", undefined, admin)).data.instances.find((i: any) => i.id === cloudId);
    expect(state.saves[0].releaseId).toBe(pinned);
    expect(state.releases).toHaveLength(2);
  }, 30000);
  it("supports admin-configurable upload limits with live enforcement", async () => {
    const policy = await call("GET", "/nomad/catalog/policy",undefined,player);
    expect(policy.data).toMatchObject({maxGiB:5,maxBytes:5368709120});
    expect((await call("PUT","/overview/setting",{nomadPackageUploadGiB:20},player)).status).toBe(403);
    expect((await call("PUT","/overview/setting",{nomadPackageUploadGiB:-1},admin)).status).toBe(400);
    expect((await call("PUT","/overview/setting",{nomadPackageUploadGiB:0.01},admin)).status).toBe(200);
    expect((await call("GET","/nomad/catalog/policy",undefined,player)).data.maxBytes).toBe(Math.floor(0.01*1024**3));
    await delay(145);const form = new FormData();form.append("package",new Blob([new Uint8Array(11*1024*1024)]),"too-large.zip");
    const rejected = await fetch(base+"/api/nomad/catalog/import?token="+admin.token,{method:"POST",headers:{Cookie:admin.cookie,"X-Requested-With":"XMLHttpRequest"},body:form});
    expect(rejected.status).toBe(413);
    expect((await call("PUT","/overview/setting",{nomadPackageUploadGiB:5},admin)).status).toBe(200);
  },30000);
  it("publishes runtime changes as a new release without silently changing existing saves", async () => {
    const listing = await call("GET","/nomad/catalog/",undefined,admin);
    const instance = listing.data.instances.find((i:any)=>i.name === "Cloud pack"), original = instance.releases[0];
    const modified = await call("POST","/nomad/catalog/instances/"+instance.id+"/releases/"+original.id+"/configure",{profile:{memoryMb:8192,packRevision:"configuration-2",launch:{windowMode:"fullscreen",memoryMode:"manual",jvmArgs:"-XX:+UseG1GC"}}},admin);
    expect(modified.status).toBe(200);expect(modified.data.sha256).toBe(original.sha256);expect(modified.data.id).not.toBe(original.id);
    expect(modified.data.profile.launch.windowMode).toBe("fullscreen");
    const after = (await call("GET","/nomad/catalog/",undefined,admin)).data.instances.find((i:any)=>i.id===instance.id);
    expect(after.saves[0].releaseId).toBe(original.id);
    expect((await call("POST","/nomad/catalog/instances/"+instance.id+"/releases/"+original.id+"/configure",{profile:{memoryMb:16384}},player)).status).toBe(403);
  });
  it("lets a normal user choose hosting willingness without editing another account or granting privileges", async () => {
    expect((await call("GET", "/auth/hosting-preference")).status).toBe(403);
    expect((await call("GET", "/auth/hosting-preference", undefined, player)).data.hostingWillingness).toBe("medium");
    expect((await call("GET", "/auth/", undefined, player)).data.hostingWillingness).toBe("medium");
    for (const value of ["high", "medium", "none", "low"]) {
      const result = await call("PUT", "/auth/hosting-preference", {hostingWillingness:value}, player);
      expect(result.status).toBe(200); expect(result.data.hostingWillingness).toBe(value);
    }
    expect((await call("PUT", "/auth/hosting-preference?_force="+Date.now(), {hostingWillingness:"low"}, player)).status).toBe(200);
    for (const body of [{hostingWillingness:"highest"},{hostingWillingness:1},{hostingWillingness:null},{},[],{hostingWillingness:"high",uuid:userId},{hostingWillingness:"high",permission:10}]) {
      expect((await call("PUT", "/auth/hosting-preference", body, player)).status).toBe(400);
    }
    expect((await call("PUT", "/auth/hosting-preference?uuid="+userId,{hostingWillingness:"high"},admin)).status).toBe(400);
    const info = (await call("GET", "/auth/", undefined, player)).data;
    expect(info.hostingWillingness).toBe("low"); expect(info.permission).toBe(1);
    expect((await call("GET", "/auth/hosting-preference", undefined, admin)).data.hostingWillingness).toBe("medium");
  });
  it("central records and unique room identity survive restarting the panel", async () => {
    const before = await call("GET", "/nomad/catalog/", undefined, admin);
    const expected = before.data.instances.find((i: any) => i.id === instanceId);
    await stop();
    const accounts = await fs.readdir(path.join(workDir,"data/User"));
    for (const account of accounts) {
      const file = path.join(workDir,"data/User",account),record=JSON.parse(await fs.readFile(file,"utf8"));
      if (record.userName === "catalog_admin") {delete record.hostingWillingness;await fs.writeFile(file,JSON.stringify(record));}
    }
    await start();
    admin = await login("catalog_admin");
    player = await login("catalog_player");
    expect((await call("GET", "/auth/hosting-preference", undefined, player)).data.hostingWillingness).toBe("low");
    expect((await call("GET", "/auth/hosting-preference", undefined, admin)).data.hostingWillingness).toBe("medium");
    const after = await call("GET", "/nomad/catalog/", undefined, admin);
    const restored = after.data.instances.find((i: any) => i.id === instanceId);
    expect(restored.saves).toEqual(expected.saves);
    expect(restored.saves).toHaveLength(2);
  });
});
