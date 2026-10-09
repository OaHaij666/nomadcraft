// The NomadCraft kernel, as a module.
//
// `general_start.ts` imports exactly one thing from here. Everything else in this
// directory is an implementation detail of how a world is coordinated, snapshotted,
// synced, and tunnelled.

export { CoordinatorClient, CoordinatorRefused, isHostBusy } from "./coordinator";
export type { Lease, ServerInfo, NodeRegistration } from "./coordinator";
export { SnapshotEngine, DEFAULT_INCLUDES, DEFAULT_EXCLUDES } from "./snapshot_engine";
export type { Manifest, ManifestEntry, SnapshotResult, RestoreResult, VerifyResult } from "./snapshot_engine";
export { SnapshotSync } from "./snapshot_sync";
export { TunnelPool, openSlot, parseHostPort } from "./tunnel";
export type { TunnelTarget } from "./tunnel";
export { HostingSession } from "./session";
export type { NomadSettings, ClaimOutcome } from "./session";
export { settingsForInstance } from "./settings";
