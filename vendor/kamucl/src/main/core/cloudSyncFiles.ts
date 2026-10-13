import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  distributionPath,
  diffManifest,
  validateManifest,
  type DistributionManifest,
} from "../../../../mcsmanager/shared/nomad-distribution";
export async function fileDigest(file: string) {
  const h = crypto.createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(file);
  for await (const c of stream) h.update(c);
  return h.digest("hex");
}
export async function confinedFile(
  directory: string,
  name: string,
): Promise<string> {
  distributionPath(name);
  return confinedRelative(directory, name);
}
async function confinedRelative(directory: string, name: string): Promise<string> {
  if (path.isAbsolute(name) || name.split(/[\\/]/).some(s => !s || s === "." || s === ".."))
    throw new Error("同步路径无效");
  const base = await fs.realpath(directory);
  let current = base;
  for (const segment of name.split("/")) {
    current = path.join(current, segment);
    const s = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (s?.isSymbolicLink()) throw new Error("同步路径不能包含符号链接");
  }
  return current;
}
export async function inventory(
  directory: string,
  manifest: DistributionManifest,
) {
  const hashes: Record<string, string> = {};
  for (const f of manifest.files.filter((f) => f.side !== "server")) {
    const file = await confinedFile(directory, f.path);
    const s = await fs.stat(file).catch(() => null);
    if (s) {
      if (!s.isFile()) throw new Error("同步文件路径被目录占用：" + f.path);
      hashes[f.path] = await fileDigest(file);
    }
  }
  return hashes;
}
export interface SyncBaseline {
  serviceId: string;
  instanceId: string;
  saveId?: string;
  releaseId: string;
  digest: string;
  manifest: DistributionManifest;
  verifiedAt: number;
}
export async function atomicRecord(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}
export async function baseline(
  directory: string,
): Promise<SyncBaseline | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(
        await confinedRelative(directory, ".nomadcraft-sync/baseline.json"),
        "utf8",
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
interface Journal {
  state: "applying" | "complete" | "rolled-back";
  folder: string;
  before?: SyncBaseline;
  after: SyncBaseline;
  items: Array<{
    path: string;
    backup?: string;
    next?: string;
    applied?: boolean;
  }>;
}
export async function pendingJournal(directory: string) {
  try {
    return JSON.parse(
      await fs.readFile(
        await confinedRelative(directory, ".nomadcraft-sync/journal.json"),
        "utf8",
      ),
    ) as Journal;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
export async function assertSyncSettled(directory: string) {
  const j = await pendingJournal(directory);
  if (j?.state === "applying")
    throw new Error(
      "云端同步尚未完成恢复，请先到云端同步页恢复或回滚，再启动游戏",
    );
}
export async function rollbackFiles(directory: string) {
  const file = path.join(directory, ".nomadcraft-sync/journal.json"),
    j = await pendingJournal(directory);
  if (!j || j.state === "rolled-back") throw new Error("没有可恢复的同步事务");
  const expectedRoot = path.join(
    await fs.realpath(directory),
    ".nomadcraft-sync",
  );
  if (path.dirname(j.folder) !== expectedRoot)
    throw new Error("恢复事务路径无效");
  for (const item of [...j.items].reverse()) {
    const dest = await confinedFile(directory, item.path);
    const exists = await fs.stat(dest).catch(() => null),
      actual = exists ? await fileDigest(dest) : undefined;
    if (actual !== item.next && item.next !== undefined && item.applied)
      throw new Error("同步后文件又被修改，请先备份并处理冲突：" + item.path);
    if (!item.backup) {
      if (actual === item.next && exists) await fs.unlink(dest);
      continue;
    }
    const backup = await confinedRelative(directory, path.relative(await fs.realpath(directory), path.join(j.folder, item.backup)));
    if (path.dirname(backup) !== j.folder) throw new Error("恢复备份路径无效");
    const original = await fileDigest(backup);
    if (actual === original) continue;
    if (actual !== item.next && actual !== undefined)
      throw new Error("恢复发现新改动，请保留当前文件：" + item.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(backup, dest);
  }
  if (j.before)
    await atomicRecord(path.join(expectedRoot, "baseline.json"), j.before);
  else
    await fs.unlink(path.join(expectedRoot, "baseline.json")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  j.state = "rolled-back";
  await atomicRecord(file, j);
  return j.before;
}
export async function applyFiles(
  directory: string,
  next: SyncBaseline,
  staged: Record<string, string>,
  accepted: string[],
  checkIdle: () => Promise<void>,
  beforeStep?: (index: number) => Promise<void>,
) {
  await assertSyncSettled(directory);
  validateManifest(next.manifest, Number.MAX_SAFE_INTEGER);
  const old = await baseline(directory);
  if (
    old &&
    (old.serviceId !== next.serviceId || old.instanceId !== next.instanceId)
  )
    throw new Error("此目录已同步其它云端实例，请使用独立本地实例");
  const all: DistributionManifest = {
    schema: 1,
    files: [
      ...new Map(
        [...(old?.manifest.files ?? []), ...next.manifest.files].map((f) => [
          f.path,
          f,
        ]),
      ).values(),
    ],
  };
  const current = await inventory(directory, all),
    diff = diffManifest(old?.manifest, next.manifest, current);
  const conflicts = diff.filter(
    (d) => d.conflict && !accepted.includes(d.path),
  );
  if (conflicts.length)
    throw new Error(
      "尚有未确认的文件冲突：" + conflicts.map((d) => d.path).join("、"),
    );
  await checkIdle();
  const folder = await confinedRelative(directory, ".nomadcraft-sync/" + crypto.randomUUID());
  await fs.mkdir(folder, { recursive: true });
  const j: Journal = {
    state: "applying",
    folder,
    before: old,
    after: next,
    items: [],
  };
  const journal = path.join(directory, ".nomadcraft-sync/journal.json");
  for (const d of diff.filter((d) => d.operation !== "same")) {
    const dest = await confinedFile(directory, d.path);
    if (d.next) {
      const source = staged[d.path];
      if (!source || (await fileDigest(source)) !== d.next)
        throw new Error("待同步文件校验失败：" + d.path);
    }
    const backup = current[d.path]
      ? String(j.items.length) + ".bak"
      : undefined;
    if (backup) {
      await fs.copyFile(dest, path.join(folder, backup));
      if ((await fileDigest(path.join(folder, backup))) !== current[d.path])
        throw new Error("备份期间文件发生修改：" + d.path);
    }
    j.items.push({ path: d.path, backup, next: d.next });
  }
  await atomicRecord(journal, j);
  try {
    for (let index = 0; index < j.items.length; index++) {
      await checkIdle();
      await beforeStep?.(index);
      const item = j.items[index],
        dest = await confinedFile(directory, item.path);
      const actual = (await fs.stat(dest).catch(() => null))
        ? await fileDigest(dest)
        : undefined;
      if (actual !== current[item.path])
        throw new Error("同步应用期间文件发生修改：" + item.path);
      if (item.next) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const tmp = dest + ".nc-sync-" + crypto.randomUUID();
        await fs.copyFile(staged[item.path], tmp);
        await fs.rename(tmp, dest);
      } else if (actual) await fs.unlink(dest);
      item.applied = true;
      await atomicRecord(journal, j);
    }
    const observed = await inventory(directory, next.manifest);
    if (
      next.manifest.files
        .filter((f) => f.side !== "server")
        .some((f) => observed[f.path] !== f.sha256)
    )
      throw new Error("同步最终校验失败");
    await atomicRecord(
      path.join(directory, ".nomadcraft-sync/baseline.json"),
      next,
    );
    j.state = "complete";
    await atomicRecord(journal, j);
    return { changes: j.items.length, baseline: next };
  } catch (error) {
    await rollbackFiles(directory).catch(() => {});
    throw error;
  }
}
