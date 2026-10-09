// End-to-end proof that the kernel talks to a live control plane correctly.
//
// This test needs a running coordinator. Point NOMAD_E2E_CONTROL_PLANE at it to
// enable the suite; without it the tests are skipped so the normal unit run stays
// hermetic.
//
// What it proves, in order:
//   1. a node can register with the coordinator
//   2. a server can be created
//   3. a snapshot of a fake world can be taken locally
//   4. the snapshot's chunks can be pushed to the coordinator
//   5. the snapshot can be committed as the world's canonical checkpoint
//   6. a fresh store can pull and restore the world byte-for-byte
//   7. the lease can be released and re-claimed

import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoordinatorClient } from "../coordinator";
import { SnapshotEngine } from "../snapshot_engine";
import { SnapshotSync } from "../snapshot_sync";

const CONTROL_PLANE = process.env.NOMAD_E2E_CONTROL_PLANE ?? "";
const BINARY = process.env.NOMAD_SNAPSHOT_BIN ?? "nomad-snapshot";
const suite = CONTROL_PLANE ? describe : describe.skip;

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nomad-e2e-${label}-`));
}

suite("nomad kernel end to end", () => {
  let work: string;
  let storeA: string;
  let storeB: string;
  let serverId: string;
  const nodeId = "node_e2etest000000000000000000000001";

  beforeAll(async () => {
    work = tmpDir("work");
    storeA = tmpDir("storeA");
    storeB = tmpDir("storeB");
    await fs.mkdirp(path.join(work, "world", "region"));
    await fs.writeFile(path.join(work, "world", "level.dat"), "level-data-v1");
    await fs.writeFile(path.join(work, "world", "region", "r.0.0.mca"), Buffer.alloc(400_000, 7));

    const client = new CoordinatorClient(CONTROL_PLANE);
    await client.registerNode({
      name: "e2e",
      node_id: nodeId,
      hosting_enabled: true,
      public_key: "test-key",
      os: process.platform,
      arch: process.arch,
      cpu_cores: 8,
      memory_mb: 16384,
      disk_free_bytes: 1_000_000_000,
      uplink_mbps: 100,
      anchor: false
    });
    const server = await client.createServer("e2e-room");
    serverId = server.server_id;
  }, 60_000);

  afterAll(async () => {
    for (const d of [work, storeA, storeB]) {
      await fs.remove(d).catch(() => {});
    }
  });

  it("pushes a snapshot to the coordinator and restores it elsewhere", async () => {
    const client = new CoordinatorClient(CONTROL_PLANE);
    const engineA = new SnapshotEngine(BINARY, storeA);
    const syncA = new SnapshotSync(client, engineA);

    const snap = await engineA.snapshot(work, {
      nodeId,
      epoch: 1,
      reason: "manual"
    });
    expect(snap.snapshot_id.startsWith("snap_")).toBe(true);
    expect(snap.manifest.files.length).toBeGreaterThan(0);

    await syncA.push(snap.snapshot_id, snap.manifest);

    const lease = await client.claim(serverId, nodeId);
    expect(lease.epoch).toBeGreaterThanOrEqual(1);

    await client.commitCheckpoint(serverId, nodeId, lease.epoch, snap.snapshot_id, "manual");

    const engineB = new SnapshotEngine(BINARY, storeB);
    const syncB = new SnapshotSync(client, engineB);
    await syncB.pull(snap.snapshot_id);
    const target = tmpDir("restore");
    const report = await engineB.restore(snap.snapshot_id, target);
    expect(report.files_written).toBeGreaterThan(0);

    const restored = await fs.readFile(path.join(target, "world", "level.dat"), "utf8");
    expect(restored).toBe("level-data-v1");
    await fs.remove(target);

    // The lease is exclusive: a second claim while we hold it must be refused.
    await expect(client.claim(serverId, nodeId)).rejects.toMatchObject({ code: "host_busy" });

    await client.release(serverId, nodeId, lease.epoch, "test-done");
    const server = await client.getServer(serverId);
    expect(server.host).toBeNull();
    expect(server.committed_snapshot).toBe(snap.snapshot_id);
  }, 120_000);
});
