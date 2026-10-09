// The host side of the relay tunnel.
//
// Players never reach a player's PC directly: they connect to the relay, and the
// relay hands the connection here. So the host keeps a small pool of outgoing
// connections to the relay's tunnel port, each announcing which room it serves.
// When the relay pairs a player with a slot, bytes flow straight through this
// process to the local Minecraft server.
//
// One socket carries one player's session. To keep more than a handful of players
// connected we simply keep more sockets parked.

import net, { Socket } from "net";
import logger from "../log";

export const SLOT_HEADER_PREFIX = "SLOT ";

/** Where and for which room this host should park tunnel slots. */
export interface TunnelTarget {
  /** `host:port` of the relay's tunnel listener. */
  relayTunnel: string;
  /** The room/hostname players will type, e.g. `friends.example.com`. */
  roomHost: string;
  /** `host:port` of the local Minecraft server. */
  localServer: string;
  /**
   * Identifies this host generation. When a new host takes over the room, the relay
   * drops every slot that carries a different token, so players can never be spliced
   * into a world that has been handed over. The lease epoch is exactly the right
   * value: it changes on every handover.
   */
  hostToken: string;
}

/**
 * Parse `host:port`, supporting a bracketed IPv6 literal like `[::1]:25565`.
 */
export function parseHostPort(raw: string): { host: string; port: number } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) throw new Error(`invalid IPv6 address: ${raw}`);
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (!rest.startsWith(":")) throw new Error(`missing port in ${raw}`);
    return { host, port: Number(rest.slice(1)) };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx < 0) throw new Error(`expected host:port, got ${raw}`);
  return { host: trimmed.slice(0, idx), port: Number(trimmed.slice(idx + 1)) };
}

/**
 * Keep one tunnel slot alive: connect to the relay, announce the room, then splice
 * the socket to the local server. When either side closes, the slot is done.
 *
 * Returns a promise that resolves when this slot's session ends.
 */
export function openSlot(target: TunnelTarget): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const { host, port } = parseHostPort(target.relayTunnel);
    const slot = net.connect({ host, port });
    slot.setNoDelay(true);
    slot.setKeepAlive(true, 30_000);

    let announced = false;
    let upstream: Socket | null = null;

    slot.on("connect", () => {
      slot.write(`${SLOT_HEADER_PREFIX}${target.roomHost} ${target.hostToken}\n`);
    });

    // The relay replies `OK\n` once the slot is parked; everything after that is
    // game traffic and belongs to the local server.
    const onSlotData = (data: Buffer) => {
      if (!announced) {
        const text = data.toString("utf8");
        if (text.startsWith("OK")) {
          announced = true;
          slot.removeListener("data", onSlotData);
          const leftover = data.subarray(text.indexOf("\n") + 1);
          upstream = connectLocal(target.localServer, slot, leftover);
          slot.on("data", (chunk) => {
            if (upstream && !upstream.destroyed) upstream.write(chunk);
          });
          slot.on("close", () => upstream?.destroy());
          slot.on("error", () => upstream?.destroy());
        } else if (text.startsWith("ERR")) {
          logger.warn(`[nomad] relay refused slot for ${target.roomHost}: ${text.trim()}`);
          slot.destroy();
        }
      }
    };
    slot.on("data", onSlotData);
    slot.on("error", (err) => {
      logger.warn(`[nomad] tunnel slot error for ${target.roomHost}: ${err.message}`);
      finish();
    });
    slot.on("close", finish);
  });
}

/** Connect to the local Minecraft server and wire it to the relay slot. */
function connectLocal(localServer: string, slot: Socket, leftover: Buffer): Socket {
  const { host, port } = parseHostPort(localServer);
  const local = net.connect({ host, port });
  local.setNoDelay(true);
  local.on("connect", () => {
    if (leftover.length > 0) local.write(leftover);
  });
  local.on("data", (chunk) => {
    if (!slot.destroyed) slot.write(chunk);
  });
  local.on("error", (err) => {
    logger.warn(`[nomad] local server unreachable at ${localServer}: ${err.message}`);
    slot.destroy();
  });
  local.on("close", () => slot.destroy());
  return local;
}

/**
 * A pool of tunnel slots for one room.
 *
 * Keeps `size` slots parked at the relay at all times, replacing each slot as soon
 * as its session ends, so a player always finds a warm slot.
 */
export class TunnelPool {
  private stopped = false;
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly target: TunnelTarget,
    private readonly size: number
  ) {}

  public start(): void {
    for (let i = 0; i < this.size; i++) this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const slot = openSlot(this.target).then(() => {
      this.active.delete(slot);
      // Replace the slot, but not in a hot loop: a refused relay would otherwise
      // spin. A short delay is enough to make this self-healing rather than busy.
      if (!this.stopped) setTimeout(() => this.spawn(), 1000);
    });
    this.active.add(slot);
  }

  public stop(): void {
    this.stopped = true;
  }

  public get activeCount(): number {
    return this.active.size;
  }
}


