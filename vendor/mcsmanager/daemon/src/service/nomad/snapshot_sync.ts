// Moving a snapshot between a player's machine and the coordinator.
//
// The coordinator holds one copy of the world's chunks. A host pulls the chunks it
// is missing before it starts, and pushes the chunks the coordinator is missing
// before it announces a checkpoint. Because chunks are named by the hash of their
// plaintext, "which chunks are missing" is just a set difference, and an upload of
// an already-present chunk is a harmless no-op.

import fs from "fs-extra";
import path from "path";
import { CoordinatorClient } from "./coordinator";
import { Manifest, SnapshotEngine } from "./snapshot_engine";
import logger from "../log";

export interface SyncReport {
  totalChunks: number;
  uploadedChunks: number;
  downloadedChunks: number;
}

/** The unique chunk hashes a manifest references, in stable order. */
export function referencedChunks(manifest: Manifest): string[] {
  const seen = new Set<string>();
  for (const file of manifest.files) {
    for (const chunk of file.chunks ?? []) seen.add(chunk);
  }
  return [...seen];
}

/** Where a store keeps a chunk's compressed bytes. */
export function chunkPath(storeDir: string, hash: string): string {
  return path.join(storeDir, "chunks", hash.slice(0, 2), hash);
}

export class SnapshotSync {
  constructor(
    private readonly client: CoordinatorClient,
    private readonly engine: SnapshotEngine
  ) {}

  private hasChunk(hash: string): boolean {
    return fs.existsSync(chunkPath(this.engine.store, hash));
  }

  /**
   * Pull every chunk of `snapshotId` that this machine is missing.
   *
   * The manifest comes from the coordinator; the chunks come from the coordinator's
   * store. After this returns, the snapshot is locally complete and can be restored.
   */
  public async pull(snapshotId: string): Promise<SyncReport> {
    const { manifest, missing_chunks } = await this.client.getManifest(snapshotId);
    const chunks = referencedChunks(manifest as Manifest);
    const report: SyncReport = { totalChunks: chunks.length, uploadedChunks: 0, downloadedChunks: 0 };

    // Trust the union of "chunks in the manifest" and "chunks the coordinator says
    // it is missing": a chunk can go missing on the coordinator side after the
    // manifest was computed, and we would rather try and fail loudly than skip it.
    const wanted = new Set<string>(chunks);

    // The manifest must land in the local store before restore can find it. The
    // engine re-hashes it, so this cannot be used to plant a wrong snapshot id.
    await this.engine.importManifest(snapshotId, manifest as Manifest);
    for (const hash of missing_chunks ?? []) wanted.add(hash);

    for (const hash of wanted) {
      if (this.hasChunk(hash)) continue;
      const compressed = await this.client.getChunk(hash);
      await fs.mkdirp(path.dirname(chunkPath(this.engine.store, hash)));
      await fs.writeFile(chunkPath(this.engine.store, hash), compressed);
      report.downloadedChunks++;
    }

    logger.info(
      `[nomad] pulled ${snapshotId}: ${report.downloadedChunks}/${report.totalChunks} chunks downloaded`
    );
    return report;
  }

  /**
   * Push every chunk of `manifest` the coordinator does not yet hold.
   *
   * The manifest is uploaded first so the coordinator can tell us exactly which
   * chunks it is missing; then we send only that difference.
   */
  public async push(snapshotId: string, manifest: Manifest): Promise<SyncReport> {
    await this.client.putManifest(snapshotId, manifest);
    const remote = await this.client.getManifest(snapshotId);
    const missing = new Set<string>(remote.missing_chunks ?? []);
    const chunks = referencedChunks(manifest);
    const report: SyncReport = { totalChunks: chunks.length, uploadedChunks: 0, downloadedChunks: 0 };

    for (const hash of chunks) {
      if (!missing.has(hash)) continue;
      const local = chunkPath(this.engine.store, hash);
      if (!fs.existsSync(local)) {
        throw new Error(`chunk ${hash} missing from local store while pushing ${snapshotId}`);
      }
      const compressed = await fs.readFile(local);
      await this.client.putChunk(hash, compressed);
      report.uploadedChunks++;
    }

    logger.info(
      `[nomad] pushed ${snapshotId}: ${report.uploadedChunks}/${report.totalChunks} chunks uploaded`
    );
    return report;
  }
}
