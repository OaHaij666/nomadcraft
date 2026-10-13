import crypto from "node:crypto";
import { app, ipcMain, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { cloudClient } from "./nomadCloud";
import {
  scanJavaForLaunch,
  selectHealthyJava,
  resolveJavaExecutable,
} from "./java";
import { atomicRecord } from "./cloudSyncFiles";
interface HostingRun {
  id: string;
  serviceId: string;
  kind: "host" | "node";
  instanceId?: string;
  saveId?: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  pid?: number;
  joinAddress?: string;
  error?: string;
  logs: string[];
  stopFile: string;
  child?: ChildProcess;
  ended?: Promise<void>;
}
const runs = new Map<string, HostingRun>();
let quitting = false;
let starting = false;
const publicRun = ({ child, ended, stopFile, ...run }: HostingRun) => run;
async function executable() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binary = path
    .join(__dirname, "nomad-agent" + suffix)
    .replace("app.asar", "app.asar.unpacked");
  if (!(await fs.stat(binary).catch(() => null)))
    throw new Error("客户端内置执行器缺失，请重新构建客户端");
  return binary;
}
async function java(input: string | undefined, major = 21) {
  if (input) {
    const exe = await resolveJavaExecutable(input);
    const info = await (await import("./java")).probeJavaAsync(exe);
    if (!info || !info.is64Bit || info.major < major)
      throw new Error("请选择满足服务端要求的 64 位 Java");
    return exe;
  }
  const available = await scanJavaForLaunch();
  const found = await selectHealthyJava(available, major);
  if (!found)
    throw new Error(
      "没有可用的 Java " + major + "，请先在运行环境中安装或选择 Java",
    );
  return found.path;
}
async function startUnlocked(
  kind: "host" | "node",
  data: any,
  input: { java?: string; ref?: { instanceId: string; saveId: string };client?:ReturnType<typeof cloudClient> },
) {
  const client = input.client ?? cloudClient();
  if (
    [...runs.values()].some(
      (r) =>
        r.serviceId === client.serviceId &&
        ["starting", "running", "stopping"].includes(r.state),
    )
  )
    throw new Error("此服务的执行器已运行，请先停止");
  const binary = await executable(),
    javaPath = await java(input.java, data.javaMajor ?? 21);
  const id = crypto.randomUUID(),
    directory = path.join(
      app.getPath("userData"),
      "cloud-hosting",
      client.serviceId,
      kind === "host" ? input.ref!.saveId : data.nodeId,
    );
  await fs.mkdir(directory, { recursive: true });
  const credential = path.join(directory, id + ".credential.json"),
    stopFile = path.join(directory, id + ".stop");
  await fs.writeFile(
    credential,
    JSON.stringify({ ...data, panel: client.origin }),
    { mode: 0o600 },
  );
  const run: HostingRun = {
    id,
    serviceId: client.serviceId,
    kind,
    instanceId: input.ref?.instanceId,
    saveId: input.ref?.saveId,
    state: "starting",
    logs: [],
    stopFile,
  };
  runs.set(id, run);
  try {
    const child = spawn(
      binary,
      [
        kind === "host" ? "panel-host" : "panel-node",
        kind === "host" ? "--ticket-file" : "--credential-file",
        credential,
        "--data-dir",
        directory,
        "--java",
        javaPath,
        "--stop-file",
        stopFile,
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    run.child = child;
    run.pid = child.pid;
    const consume = (value: Buffer) => {
      const text = value
        .toString("utf8")
        .replace(/Bearer\s+\S+/g, "Bearer [redacted]");
      run.logs.push(text.slice(-4000));
      run.logs = run.logs.slice(-100);
      const ready = text.match(/NOMAD_READY\s+(\S+)/);
      if (ready) {
        run.state = "running";
        run.joinAddress = ready[1];
      }
      if (/NOMAD_STOPPED/.test(text)) run.state = "stopped";
      if (/NOMAD_NODE_READY|NOMAD_NODE_REGISTERED/.test(text))
        run.state = "running";
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    run.ended = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        run.state = "failed";
        run.error = error.message;
        resolve();
      });
      child.once("exit", (code) => {
        if (code === 0) run.state = "stopped";
        else {
          run.state = "failed";
          run.error = "执行器退出 " + code + "；本地存档保留，请查看日志";
        }
        resolve();
      });
    }).finally(() => fs.unlink(credential).catch(() => {}));
    return publicRun(run);
  } catch (error) {
    run.state = "failed";
    await fs.unlink(credential).catch(() => {});
    throw error;
  }
}
async function start(
  kind: "host" | "node",
  data: any,
  input: { java?: string; ref?: { instanceId: string; saveId: string };client?:ReturnType<typeof cloudClient> },
) {
  if (starting) throw new Error("执行器正在启动");
  starting = true;
  try {
    return await startUnlocked(kind, data, input);
  } finally {
    starting = false;
  }
}
export function registerCloudHostingIpc() {
  ipcMain.handle("nomad:hosting:status", () =>
    [...runs.values()].map(publicRun),
  );
  ipcMain.handle(
    "nomad:hosting:host",
    async (
      _e,
      ref: { instanceId: string; saveId: string },
      javaPath?: string,
    ) => {
      const client = cloudClient();
      const catalog = await client.json("api/nomad/catalog/");
      const instance = catalog.instances.find(
          (v: any) => v.id === ref.instanceId,
        ),
        save = instance?.saves.find((v: any) => v.id === ref.saveId),
        release = instance?.releases.find((v: any) => v.id === save?.releaseId);
      if (!save?.hostingAllowed) throw new Error("没有此存档的托管资格");
      if (!release?.server || !["vanilla", "fabric", "forge", "neoforge", "paper"].includes(release.server.type))
        throw new Error("此发布版缺少受支持的服务端环境");
      await executable();
      await java(javaPath, release.server.javaMajor);
      const ticket = await client.json("api/nomad/hosting/tickets", {
        method: "POST",
        body: JSON.stringify({ ...ref, nodeName: os.hostname() }),
      });
      return start(
        "host",
        { ...ticket, javaMajor: release.server.javaMajor },
        { java: javaPath, ref,client },
      );
    },
  );
  ipcMain.handle(
    "nomad:hosting:pair",
    async (_e, input: { name: string; memoryBudgetMb: number }) => {
      const client = cloudClient();
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统安全存储不可用，无法保存节点配对凭据");
      const result = await client.json("api/nomad/hosting/nodes", {
        method: "POST",
        body: JSON.stringify({
          kind: "player",
          name: input.name || os.hostname(),
          memoryBudgetMb: input.memoryBudgetMb,
          priority: 0,
        }),
      });
      const file = path.join(
        app.getPath("userData"),
        "cloud-nodes",
        client.serviceId + ".json",
      );
      await atomicRecord(file, {
        serviceId: client.serviceId,
        username: (await import("./nomadCloud")).status().username,
        node: result.node,
        credential: safeStorage
          .encryptString(JSON.stringify(result.credential))
          .toString("base64"),
      });
      return result.node;
    },
  );
  ipcMain.handle("nomad:hosting:nodeInfo", async () => {
    const client = cloudClient();
    try {
      const record = JSON.parse(
        await fs.readFile(
          path.join(
            app.getPath("userData"),
            "cloud-nodes",
            client.serviceId + ".json",
          ),
          "utf8",
        ),
      );
      return {
        node: record.node,
        accountMatches:
          record.username === (await import("./nomadCloud")).status().username,
      };
    } catch {
      return null;
    }
  });
  ipcMain.handle("nomad:hosting:node", async (_e, javaPath?: string) => {
    const client = cloudClient(),
      record = JSON.parse(
        await fs.readFile(
          path.join(
            app.getPath("userData"),
            "cloud-nodes",
            client.serviceId + ".json",
          ),
          "utf8",
        ),
      );
    if (record.username !== (await import("./nomadCloud")).status().username)
      throw new Error("此节点属于另一个账号，请登录原账号或重新配对");
    const credential = JSON.parse(
      safeStorage.decryptString(Buffer.from(record.credential, "base64")),
    );
    const result = await start("node", credential, { java: javaPath,client });
    const r = runs.get(result.id)!;
    r.state = "running";
    return publicRun(r);
  });
  ipcMain.handle("nomad:hosting:nodes", async (_e, instanceId?:string) => cloudClient().json("api/nomad/hosting/nodes"+(instanceId?"?instanceId="+encodeURIComponent(instanceId):"")));
  ipcMain.handle("nomad:hosting:handover", async (_e, ref:{instanceId:string;saveId:string}, targetNodeId:string) => {
    if(!ref?.instanceId||!ref.saveId||typeof targetNodeId!=="string"||!targetNodeId)throw new Error("请选择存档和接手的计算节点");
    try{return await cloudClient().json("api/nomad/hosting/runtime/"+encodeURIComponent(ref.instanceId)+"/"+encodeURIComponent(ref.saveId)+"/handover",{method:"POST",body:JSON.stringify({targetNodeId})});}
    catch(error){const text=String(error);const messages:Record<string,string>={handover_gateway_required:"管理员尚未为此房间配置不断线网关，请先配置固定入口。",handover_gateway_not_ready:"房间网关尚未就绪，请等待网关启动或检查网络状态。",handover_host_not_ready:"房间尚未就绪，暂时不能交接。",handover_in_progress:"房间正在交接，请等待完成。",handover_same_node:"请选择另一台计算节点。",handover_target_unavailable:"目标节点离线、已禁用或没有此存档的托管权限。",node_capacity_exceeded:"目标节点的内存或并发任务额度不足。",forbidden:"你没有此房间的管理权限。"};for(const [code,message]of Object.entries(messages))if(text.includes(code))throw new Error(message);throw error;}
  });
  ipcMain.handle("nomad:hosting:stop", async (_e, id: string) => {
    const r = runs.get(id);
    if (!r || !r.child) throw new Error("执行器不存在");
    if (["stopped", "failed"].includes(r.state)) return publicRun(r);
    r.state = "stopping";
    await fs.writeFile(r.stopFile, "stop");
    return publicRun(r);
  });
  app.on("before-quit", (event) => {
    const active = [...runs.values()].filter((r) =>
      ["starting", "running", "stopping"].includes(r.state),
    );
    if (!active.length || quitting) return;
    event.preventDefault();
    void Promise.all(
      active.map(async (r) => {
        r.state = "stopping";
        await fs.writeFile(r.stopFile, "stop");
        await r.ended;
      }),
    ).then(() => {
      quitting = true;
      app.quit();
    });
  });
}
