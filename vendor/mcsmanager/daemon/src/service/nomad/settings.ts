// Reading NomadCraft settings off the environment.
//
// The daemon is configured by whoever deploys it, and the coordinator's address is
// deployment-specific. Environment variables keep this out of the inherited
// MCSManager config schema (which we do not want to fork) and let one machine run
// both a normal instance and a coordinated one.

import path from "path";
import { NomadSettings } from "./session";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function flag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Build settings for one instance.
 *
 * Everything is optional except the coordinator address: a daemon with no
 * `NOMAD_CONTROL_PLANE` set behaves exactly like the MCSManager it came from, which
 * keeps the fallback path honest.
 */
export function settingsForInstance(instanceUuid: string, config: any): NomadSettings {
  const dataDir = env("NOMAD_DATA_DIR", path.join(process.cwd(), ".nomad"));
  return {
    enabled: env("NOMAD_CONTROL_PLANE").length > 0,
    controlPlane: env("NOMAD_CONTROL_PLANE", "http://127.0.0.1:8787"),
    nodeId: env("NOMAD_NODE_ID", "node_local"),
    storeDir: env("NOMAD_STORE_DIR", path.join(dataDir, "store")),
    snapshotBinary: env("NOMAD_SNAPSHOT_BIN", "nomad-snapshot"),
    // A server id defaults to the instance's own uuid so an operator only has to set
    // the coordinator address for a single-instance deployment.
    serverId: env("NOMAD_SERVER_ID", instanceUuid),
    roomHost: env("NOMAD_ROOM_HOST", config?.nickname ?? instanceUuid),
    relayTunnel: env("NOMAD_RELAY_TUNNEL", ""),
    tunnelSlots: Number(env("NOMAD_TUNNEL_SLOTS", "4")) || 4,
    checkpointIntervalMs: Number(env("NOMAD_CHECKPOINT_MS", "120000")) || 120_000
  };
}
