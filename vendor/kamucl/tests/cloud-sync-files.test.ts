import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  applyFiles,
  rollbackFiles,
  baseline,
  assertSyncSettled,
  atomicRecord,
  fileDigest,
  confinedFile,
} from "../src/main/core/cloudSyncFiles";
import {
  manifestDigest,
  type DistributionManifest,
} from "../../mcsmanager/shared/nomad-distribution";
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const manifest = (s: string): DistributionManifest => ({
  schema: 1,
  files: [
    {
      path: "mods/core.jar",
      sha256: hash(s),
      size: Buffer.byteLength(s),
      side: "both",
      ownership: "managed",
    },
  ],
});
async function fixture(run: (dir: string, temp: string) => Promise<void>) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nc-sync-"));
  const dir = path.join(temp, "game");
  await fs.mkdir(path.join(dir, "mods"), { recursive: true });
  try {
    await run(dir, temp);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
const next = (m: DistributionManifest) => ({
  serviceId: "service",
  instanceId: "instance",
  releaseId: manifestDigest(m),
  digest: manifestDigest(m),
  manifest: m,
  verifiedAt: Date.now(),
});
test("sync preserves unknown files and shader/database data, rollback restores prior bytes", () =>
  fixture(async (dir, temp) => {
    await fs.mkdir(path.join(dir, "shaderpacks"));
    await fs.mkdir(path.join(dir, "config"));
    await fs.writeFile(path.join(dir, "shaderpacks/personal.zip"), "personal");
    await fs.writeFile(path.join(dir, "config/cache.sqlite-wal"), "runtime");
    await fs.writeFile(path.join(dir, "mods/extra.jar"), "unknown");
    const stage = path.join(temp, "new");
    await fs.writeFile(stage, "new");
    await applyFiles(
      dir,
      next(manifest("new")),
      { "mods/core.jar": stage },
      [],
      async () => {},
    );
    assert.equal(
      await fs.readFile(path.join(dir, "mods/core.jar"), "utf8"),
      "new",
    );
    assert.equal(
      await fs.readFile(path.join(dir, "mods/extra.jar"), "utf8"),
      "unknown",
    );
    await rollbackFiles(dir);
    assert.equal(await baseline(dir), undefined);
    await assert.rejects(fs.stat(path.join(dir, "mods/core.jar")));
    assert.equal(
      await fs.readFile(path.join(dir, "config/cache.sqlite-wal"), "utf8"),
      "runtime",
    );
  }));
test("conflicts require explicit consent and leave files intact otherwise", () =>
  fixture(async (dir, temp) => {
    await fs.writeFile(path.join(dir, "mods/core.jar"), "local");
    const stage = path.join(temp, "new");
    await fs.writeFile(stage, "cloud");
    await assert.rejects(
      applyFiles(
        dir,
        next(manifest("cloud")),
        { "mods/core.jar": stage },
        [],
        async () => {},
      ),
      /冲突/,
    );
    assert.equal(
      await fs.readFile(path.join(dir, "mods/core.jar"), "utf8"),
      "local",
    );
    await applyFiles(
      dir,
      next(manifest("cloud")),
      { "mods/core.jar": stage },
      ["mods/core.jar"],
      async () => {},
    );
    await rollbackFiles(dir);
    assert.equal(
      await fs.readFile(path.join(dir, "mods/core.jar"), "utf8"),
      "local",
    );
  }));
test("managed deletion is limited to prior inventory", () =>
  fixture(async (dir, temp) => {
    const stage = path.join(temp, "new");
    await fs.writeFile(stage, "one");
    await applyFiles(
      dir,
      next(manifest("one")),
      { "mods/core.jar": stage },
      [],
      async () => {},
    );
    await fs.writeFile(path.join(dir, "mods/untracked.jar"), "keep");
    await applyFiles(
      dir,
      next({ schema: 1, files: [] }),
      {},
      [],
      async () => {},
    );
    await assert.rejects(fs.stat(path.join(dir, "mods/core.jar")));
    assert.equal(
      await fs.readFile(path.join(dir, "mods/untracked.jar"), "utf8"),
      "keep",
    );
    await rollbackFiles(dir);
    assert.equal(
      await fs.readFile(path.join(dir, "mods/core.jar"), "utf8"),
      "one",
    );
  }));
test("activation failure restores coherent previous release and launch blocks unfinished journal", () =>
  fixture(async (dir, temp) => {
    const a = path.join(temp, "a"),
      b = path.join(temp, "b");
    await fs.writeFile(a, "one");
    await fs.writeFile(b, "two");
    await applyFiles(
      dir,
      next(manifest("one")),
      { "mods/core.jar": a },
      [],
      async () => {},
    );
    const before = await baseline(dir);
    const m: DistributionManifest = {
      schema: 1,
      files: [
        ...manifest("two").files,
        {
          path: "mods/another.jar",
          size: 3,
          sha256: hash("two"),
          side: "both",
          ownership: "managed",
        },
      ],
    };
    await assert.rejects(
      applyFiles(
        dir,
        next(m),
        { "mods/core.jar": b, "mods/another.jar": b },
        [],
        async () => {},
        async (i) => {
          if (i === 1) throw new Error("injected disk failure");
        },
      ),
      /injected/,
    );
    assert.equal(
      await fs.readFile(path.join(dir, "mods/core.jar"), "utf8"),
      "one",
    );
    assert.equal((await baseline(dir))?.digest, before?.digest);
    await atomicRecord(path.join(dir, ".nomadcraft-sync/journal.json"), {
      state: "applying",
    });
    await assert.rejects(assertSyncSettled(dir), /恢复/);
  }));
test("sync never follows a junction outside the instance", () =>
  fixture(async (dir, temp) => {
    const outside = path.join(temp, "outside");
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(dir, "config"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(confinedFile(dir, "config/stolen.txt"), /符号链接/);
  }));

test("sync refuses an internal journal junction outside the instance", () =>
  fixture(async (dir, temp) => {
    const outside = path.join(temp, "outside-journal");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(dir, ".nomadcraft-sync"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(baseline(dir), /符号链接/);
    await assert.rejects(assertSyncSettled(dir), /符号链接/);
    const stage = path.join(temp, "new");
    await fs.writeFile(stage, "new");
    await assert.rejects(applyFiles(dir, next(manifest("new")), { "mods/core.jar": stage }, [], async () => {}), /符号链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  }));
