// The world-snapshot engine, as seen from the daemon.
//
// The actual chunking/hashing/verification lives in the Rust `nomad-snapshot`
// binary. This wrapper is a thin, typed shell around it: it runs the binary,
// parses its single-line JSON, and turns failures into errors. Keeping the engine
// in one language means a snapshot written by a player's machine and a snapshot
// read by the coordinator can never disagree about chunk boundaries or ids.
//
// The only intelligence here is *what to snapshot*: which files under a Minecraft
// server directory travel with the world. That list is deliberately conservative —
// copying a server's entire directory would drag in huge jars and logs, while
// copying only `world/` would lose level data and mods.

import { execFile } from "child_process";
import fs from "fs-extra";
import path from "path";
import logger from "../log";

/** One file entry in a snapshot manifest, as produced by the Rust engine. */
export interface ManifestEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  blake3: string;
  chunks?: string[];
}

export interface Manifest {
  format: number;
  epoch: number;
  node_id: string;
  parent?: string | null;
  created_at_unix_ms: number;
  reason: string;
  files: ManifestEntry[];
}

export interface SnapshotResult {
  snapshot_id: string;
  file_count: number;
  chunk_count: number;
  new_chunks: number;
  total_bytes: number;
  manifest: Manifest;
}

export interface RestoreResult {
  files_written: number;
  bytes_written: number;
  removed: string[];
}

export interface VerifyResult {
  ok: boolean;
  files_checked?: number;
  chunks_checked?: number;
  missing_chunks?: string[];
  corrupt_chunks?: string[];
  error?: string;
}

/**
 * Which paths travel with a world.
 *
 * Includes cover the world folders, the flattened world format, server config, and
 * the things that decide how the world behaves (jars, mods, datapacks, plugins).
 * Excludes cover the files that must never be copied: session locks (Minecraft
 * holds them exclusively) and volatile logs.
 */
export const DEFAULT_INCLUDES = [
  "world*/",
  "level.dat",
  "server.properties",
  "ops.json",
  "whitelist.json",
  "banned-ips.json",
  "banned-players.json",
  "server.jar",
  "eula.txt",
  "mods/",
  "config/",
  "plugins/",
  "datapacks/",
  "bukkit.yml",
  "spigot.yml",
  "paper.yml",
  "paper-global.yml",
  "paper-world-defaults.yml"
];

export const DEFAULT_EXCLUDES = ["world*/session.lock", "logs/", "crash-reports/"];

export class SnapshotEngine {
  /** Absolute path to the `nomad-snapshot` binary. */
  private readonly binary: string;
  private readonly storeDir: string;

  constructor(binary: string, storeDir: string) {
    this.binary = binary;
    this.storeDir = storeDir;
  }

  public get store(): string {
    return this.storeDir;
  }

  /** Ensure the store directory exists before the engine touches it. */
  public async ensureStore(): Promise<void> {
    await fs.mkdirp(this.storeDir);
  }

  private run(args: string[], timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binary,
        args,
        { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `nomad-snapshot ${args[0]} failed: ${error.message}${
                  stderr ? ` :: ${String(stderr).trim()}` : ""
                }`
              )
            );
            return;
          }
          resolve(String(stdout).trim());
        }
      );
      child.on("error", reject);
    });
  }

  /** Take a snapshot of `serverDir`; returns its id and manifest. */
  public async snapshot(
    serverDir: string,
    opts: {
      nodeId: string;
      epoch: number;
      parent?: string | null;
      reason?: string;
      includes?: string[];
      excludes?: string[];
    }
  ): Promise<SnapshotResult> {
    await this.ensureStore();
    const args = ["snapshot", serverDir, this.storeDir, "--node", opts.nodeId];
    args.push("--epoch", String(opts.epoch));
    for (const p of opts.includes ?? DEFAULT_INCLUDES) args.push("--include", p);
    for (const p of opts.excludes ?? DEFAULT_EXCLUDES) args.push("--exclude", p);
    if (opts.parent) args.push("--parent", opts.parent);
    args.push("--reason", opts.reason ?? "scheduled");

    const out = await this.run(args);
    const parsed = JSON.parse(out) as SnapshotResult;
    logger.info(
      `[nomad] snapshot ${parsed.snapshot_id} files=${parsed.file_count} chunks=${parsed.chunk_count} new=${parsed.new_chunks} bytes=${parsed.total_bytes}`
    );
    return parsed;
  }

  /**
   * Import a manifest fetched from a peer into the local store.
   *
   * The engine verifies the manifest hashes to `snapshotId` before accepting it, so
   * a peer cannot hand us a manifest under a false name.
   */
  public async importManifest(snapshotId: string, manifest: Manifest): Promise<void> {
    await this.ensureStore();
    const tmpDir = path.join(this.storeDir, "tmp");
    await fs.mkdirp(tmpDir);
    const tmpFile = path.join(tmpDir, `manifest-${snapshotId}-${Date.now()}.json`);
    await fs.writeJson(tmpFile, manifest);
    try {
      await this.run(["import-manifest", this.storeDir, tmpFile, "--expect", snapshotId]);
    } finally {
      await fs.remove(tmpFile).catch(() => undefined);
    }
  }

  /** Restore a snapshot from the local store into `dest`. */
  public async restore(snapshotId: string, dest: string): Promise<RestoreResult> {
    const out = await this.run(["restore", this.storeDir, snapshotId, dest]);
    return JSON.parse(out) as RestoreResult;
  }

  /** Verify a snapshot's chunks without restoring it. */
  public async verify(snapshotId: string): Promise<VerifyResult> {
    try {
      const out = await this.run(["verify", this.storeDir, snapshotId]);
      return JSON.parse(out) as VerifyResult;
    } catch (error: any) {
      // The engine exits non-zero for an invalid snapshot; its stdout still holds
      // the machine-readable report, but execFile gives it to us on `stdout`.
      const match = /(\{.*\})/s.exec(String(error?.message ?? ""));
      if (match) {
        try {
          return JSON.parse(match[1]) as VerifyResult;
        } catch {
          // fall through
        }
      }
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /** List snapshot ids held in the local store. */
  public async list(): Promise<string[]> {
    await this.ensureStore();
    const out = await this.run(["list", this.storeDir]);
    return JSON.parse(out) as string[];
  }

  /**
   * The most recent snapshot a store holds whose manifest is complete enough to
   * restore. Used when this machine is handed a lease and must catch up first.
   */
  public async latestLocal(): Promise<string | null> {
    const ids = await this.list();
    if (ids.length === 0) return null;
    // Manifest digest ids are opaque; order by the manifest's creation time.
    let best: { id: string; at: number } | null = null;
    for (const id of ids) {
      try {
        const manifestPath = path.join(this.storeDir, "snapshots", `${id}.json`);
        const manifest = (await fs.readJson(manifestPath)) as Manifest;
        const at = manifest.created_at_unix_ms ?? 0;
        if (!best || at > best.at) best = { id, at };
      } catch {
        // Skip an unreadable manifest rather than failing the whole listing.
      }
    }
    return best?.id ?? null;
  }
}

