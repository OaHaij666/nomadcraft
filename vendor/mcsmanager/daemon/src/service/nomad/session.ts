// A hosting session: the lifetime of "this machine is running the world."
//
// This is the piece NomadCraft adds to MCSManager. A normal daemon starts a game
// process and forgets about it. Here, before a process may start, this machine must
// win a lease from the coordinator, catch up on the world, and open its tunnel; and
// when the process stops, this machine must leave the world safely behind before it
// lets go of the lease.
//
// The order is the whole design:
//
//   fence     claim the lease — only the winner is allowed to touch the world
//   catch up  pull the committed snapshot and restore it into the working directory
//   serve     start the process, park tunnel slots at the relay
//   protect   checkpoint on a cadence while running
//   hand over final checkpoint, then release the lease
//
// Every exit path funnels through `finish()` so a crash of the *game* still leaves a
// committed world behind, and a crash of the *daemon* simply lets the lease expire.

import fs from "fs-extra";
import { CoordinatorClient, isHostBusy } from "./coordinator";
import { SnapshotEngine } from "./snapshot_engine";
import { SnapshotSync } from "./snapshot_sync";
import { TunnelPool } from "./tunnel";
import logger from "../log";

export interface NomadSettings {
  /** Whether NomadCraft coordination is enabled for this daemon at all. */
  enabled: boolean;
  /** Base URL of the coordinator. */
  controlPlane: string;
  /** This daemon's node id, as registered with the coordinator. */
  nodeId: string;
  /** Absolute path to the snapshot store on this machine. */
  storeDir: string;
  /** Absolute path to the `nomad-snapshot` binary. */
  snapshotBinary: string;
  /** The coordinator server id this instance hosts. */
  serverId: string;
  /** The room hostname players connect with. */
  roomHost: string;
  /** `host:port` of the relay tunnel. */
  relayTunnel: string;
  /** How many player slots to keep warm. */
  tunnelSlots: number;
  /** Checkpoint cadence while running, in milliseconds. */
  checkpointIntervalMs: number;
}

export interface HostingSessionCallbacks {
  /** Called with human-readable progress, routed to the instance console. */
  onProgress: (message: string) => void;
}

/** The outcome of trying to become host. */
export type ClaimOutcome =
  | { kind: "granted"; epoch: number }
  | { kind: "busy"; holder: string }
  | { kind: "disabled" };

/**
 * One active hosting session. Owned by the start command, which calls `finish()`
 * when the game process exits.
 */
export class HostingSession {
  private readonly client: CoordinatorClient;
  private readonly engine: SnapshotEngine;
  private readonly sync: SnapshotSync;
  private tunnel: TunnelPool | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private checkpointer: NodeJS.Timeout | null = null;
  private checkpointInFlight = false;
  private lastSnapshot: string | null = null;
  private stopped = false;

  constructor(
    private readonly settings: NomadSettings,
    private readonly callbacks: HostingSessionCallbacks
  ) {
    this.client = new CoordinatorClient(settings.controlPlane);
    this.engine = new SnapshotEngine(settings.snapshotBinary, settings.storeDir);
    this.sync = new SnapshotSync(this.client, this.engine);
  }

  private say(message: string): void {
    logger.info(`[nomad] ${message}`);
    this.callbacks.onProgress(message);
  }

  /**
   * Try to become the host and bring the local world up to date.
   *
   * On success the working directory holds the committed world, this machine holds
   * the lease, and a checkpoint loop is running. The caller may then start the game.
   */
  public async begin(workingDir: string): Promise<ClaimOutcome> {
    if (!this.settings.enabled) {
      this.say("NomadCraft coordination disabled; starting locally.");
      return { kind: "disabled" };
    }

    this.say(`正在向协调器申请主机租约 (${this.settings.serverId}) …`);
    let lease;
    try {
      lease = await this.client.claim(this.settings.serverId, this.settings.nodeId);
    } catch (error) {
      if (isHostBusy(error)) {
        this.say("另一台机器已经在运行这个世界，本机不启动。");
        return { kind: "busy", holder: String((error as any).message ?? "") };
      }
      throw error;
    }

    this.say(`已获得租约：epoch=${lease.epoch}，本机为主机。`);

    // Catch up before touching the working directory.
    if (lease.restore_snapshot) {
      this.say(`正在从快照 ${lease.restore_snapshot} 恢复世界 …`);
      await this.sync.pull(lease.restore_snapshot);
      await fs.mkdirp(workingDir);
      const report = await this.engine.restore(lease.restore_snapshot, workingDir);
      this.lastSnapshot = lease.restore_snapshot;
      this.say(`世界已恢复：${report.files_written} 个文件，${report.bytes_written} 字节。`);
    } else {
      this.say("协调器没有已提交的世界快照，将从本地目录开始。");
      this.lastSnapshot = await this.engine.latestLocal();
    }

    this.startHeartbeat(lease.epoch);
    return { kind: "granted", epoch: lease.epoch };
  }

  /** Start parking tunnel slots and the checkpoint loop once the game is up. */
  public serve(): void {
    if (!this.settings.enabled) return;
    if (this.settings.relayTunnel && this.settings.roomHost) {
      this.tunnel = new TunnelPool(
        {
          relayTunnel: this.settings.relayTunnel,
          roomHost: this.settings.roomHost,
          localServer: "127.0.0.1:25565",
          // The epoch is this host generation: the relay drops any slot that carries
          // a different one, so a stale host can never serve players after handover.
          hostToken: String(this.lastEpoch)
        },
        Math.max(1, this.settings.tunnelSlots)
      );
      this.tunnel.start();
      this.say(`已在 relay 上为主机名 ${this.settings.roomHost} 打开 ${this.settings.tunnelSlots} 个通道。`);
    }

    this.checkpointer = setInterval(
      () => void this.checkpoint("scheduled"),
      Math.max(15_000, this.settings.checkpointIntervalMs)
    );
  }

  private startHeartbeat(epoch: number): void {
    const every = 10_000;
    this.heartbeat = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.client.renew(this.settings.serverId, this.settings.nodeId, epoch);
      } catch (error: any) {
        // Losing the lease means someone else owns the world now. That is a real
        // failure, not a warning: continuing to run would fork the world.
        this.say(`续租失败：${error?.message ?? error}。本机已不再是合法主机，将停止以避免存档分裂。`);
        this.callbacks.onProgress("NOMAD_LOST_LEASE");
      }
    }, every);
  }

  /** Take a snapshot, upload it, and announce it as the committed checkpoint. */
  public async checkpoint(reason: string): Promise<void> {
    if (!this.settings.enabled || this.stopped || this.checkpointInFlight) return;
    if (!this.lastEpoch) return;
    this.checkpointInFlight = true;
    try {
      const snap = await this.engine.snapshot(await this.workingDir(), {
        nodeId: this.settings.nodeId,
        epoch: this.lastEpoch,
        parent: this.lastSnapshot,
        reason
      });
      await this.sync.push(snap.snapshot_id, snap.manifest);
      await this.client.commitCheckpoint(
        this.settings.serverId,
        this.settings.nodeId,
        this.lastEpoch,
        snap.snapshot_id,
        reason
      );
      this.lastSnapshot = snap.snapshot_id;
      this.say(`存档检查点已提交：${snap.snapshot_id}（${reason}）`);
    } catch (error: any) {
      logger.error(`[nomad] checkpoint failed: ${error?.message ?? error}`);
    } finally {
      this.checkpointInFlight = false;
    }
  }

  private lastEpoch = 0;
  private workingDirPath = "";

  /** Remember the working directory and epoch so checkpoints can find them. */
  public bind(workingDir: string, epoch: number): void {
    this.workingDirPath = workingDir;
    this.lastEpoch = epoch;
  }

  private async workingDir(): Promise<string> {
    return this.workingDirPath;
  }

  /**
   * Leave the world safely: stop protecting, take a final checkpoint, release.
   *
   * Safe to call more than once; only the first call does anything.
   */
  public async finish(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.checkpointer) clearInterval(this.checkpointer);
    this.tunnel?.stop();

    if (!this.settings.enabled) return;

    try {
      await this.checkpoint("final");
    } catch (error: any) {
      logger.warn(`[nomad] final checkpoint failed: ${error?.message ?? error}`);
    }
    try {
      await this.client.release(this.settings.serverId, this.settings.nodeId, this.lastEpoch, "stopped");
      this.say("已释放主机租约，其他机器可以接管。");
    } catch (error: any) {
      logger.warn(`[nomad] release failed: ${error?.message ?? error}`);
    }
  }
}

