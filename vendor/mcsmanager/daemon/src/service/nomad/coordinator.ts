// NomadCraft coordinator client.
//
// The daemon is a guest on the coordinator: it never decides who hosts, it only
// asks and obeys. This is the single place where that conversation happens, so the
// rest of the daemon (and everything we inherited from MCSManager) stays unaware
// that hosting is coordinated at all.
//
// Design notes:
//   * Only the standard global `fetch` (Node 18+) is used, so nothing new is
//     added to the daemon's dependency tree.
//   * Every call is typed and small on purpose: the coordinator is the authority,
//     so the failure modes we care about (conflict -> someone else won the lease)
//     are surfaced as distinct errors instead of stringly-typed responses.

import logger from "../log";

export interface Lease {
  server_id: string;
  node_id: string;
  epoch: number;
  expires_at_unix_ms: number;
  restore_snapshot: string | null;
}

export interface ServerInfo {
  server_id: string;
  room_id: string;
  epoch: number;
  host: string | null;
  committed_snapshot: string | null;
}

export interface NodeRegistration {
  name: string;
  node_id?: string;
  public_key?: string;
  os?: string;
  arch?: string;
  cpu_cores?: number;
  memory_mb?: number;
  disk_free_bytes?: number;
  uplink_mbps?: number;
  hosting_enabled?: boolean;
  anchor?: boolean;
}

/** A refusal the coordinator expressed in its own words (HTTP 4xx/5xx). */
export class CoordinatorRefused extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CoordinatorRefused";
  }
}

/** Whether a claim failed because another machine already holds the lease. */
export function isHostBusy(error: unknown): boolean {
  return error instanceof CoordinatorRefused && error.code === "host_busy";
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class CoordinatorClient {
  private readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  /** The configured coordinator base URL. */
  public get url(): string {
    return this.base;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error: any) {
      throw new CoordinatorRefused(
        0,
        "transport_error",
        `cannot reach coordinator at ${this.base}${path}: ${error?.message ?? error}`
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      let code = "refused";
      let message = text || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        code = parsed.code ?? code;
        message = parsed.message ?? message;
      } catch {
        // Non-JSON error body: keep the raw text.
      }
      throw new CoordinatorRefused(response.status, code, message);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Announce this machine so the coordinator can schedule it. */
  public async registerNode(reg: NodeRegistration): Promise<{ node_id: string; anchor: boolean }> {
    const result = await this.request("POST", "/v1/nodes/register", reg);
    logger.info(`[nomad] registered with coordinator as ${result?.node_id}`);
    return result;
  }

  /** Create a new coordinated server (a world) in a room. */
  public async createServer(name: string, roomId?: string): Promise<ServerInfo> {
    return this.request("POST", "/v1/servers", { name, room_id: roomId ?? null });
  }

  /** Fetch a server's current state (who hosts it, the committed snapshot, ...). */
  public async getServer(serverId: string): Promise<ServerInfo> {
    return this.request("GET", `/v1/servers/${encodeURIComponent(serverId)}`);
  }

  /** Ask to become the host. Throws `host_busy` if someone else already holds it. */
  public async claim(serverId: string, nodeId?: string): Promise<Lease> {
    return this.request("POST", `/v1/servers/${encodeURIComponent(serverId)}/claim`, {
      node_id: nodeId ?? null
    });
  }

  /** Prove we are still the host, extending the lease. */
  public async renew(serverId: string, nodeId: string, epoch: number): Promise<Lease> {
    return this.request("POST", `/v1/servers/${encodeURIComponent(serverId)}/renew`, {
      node_id: nodeId,
      epoch,
      reason: "heartbeat"
    });
  }

  /** Give the lease back so another machine can take over immediately. */
  public async release(
    serverId: string,
    nodeId: string,
    epoch: number,
    reason: string
  ): Promise<void> {
    await this.request("POST", `/v1/servers/${encodeURIComponent(serverId)}/release`, {
      node_id: nodeId,
      epoch,
      reason
    });
  }

  /** Announce that a snapshot is fully uploaded and safe to restore from. */
  public async commitCheckpoint(
    serverId: string,
    nodeId: string,
    epoch: number,
    snapshotId: string,
    reason: string
  ): Promise<void> {
    await this.request("POST", `/v1/servers/${encodeURIComponent(serverId)}/checkpoint`, {
      node_id: nodeId,
      epoch,
      snapshot_id: snapshotId,
      reason
    });
  }

  /** The manifest describing a snapshot, plus which chunks we still need. */
  public async getManifest(
    snapshotId: string
  ): Promise<{ snapshot_id: string; manifest: any; missing_chunks: string[] }> {
    return this.request(
      "GET",
      `/v1/snapshots/${encodeURIComponent(snapshotId)}/manifest`
    );
  }

  /** Upload a snapshot manifest under its own digest id. */
  public async putManifest(snapshotId: string, manifest: unknown): Promise<void> {
    await this.request(
      "PUT",
      `/v1/snapshots/${encodeURIComponent(snapshotId)}/manifest`,
      manifest
    );
  }

  /** Download one compressed chunk. */
  public async getChunk(hash: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(
        `${this.base}/v1/snapshots/x/chunks/${encodeURIComponent(hash)}`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        throw new CoordinatorRefused(response.status, "chunk_missing", `no chunk ${hash}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Upload one compressed chunk under its content hash. */
  public async putChunk(hash: string, compressed: Buffer): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(
        `${this.base}/v1/snapshots/x/chunks/${encodeURIComponent(hash)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: compressed,
          signal: controller.signal
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new CoordinatorRefused(response.status, "upload_refused", text);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}


