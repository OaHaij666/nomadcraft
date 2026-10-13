import type {PlacementPolicy,NetworkIngress} from "./nomad-compute";
import type { HostingView } from "./nomad-hosting";
export const CATALOG_PERMISSIONS = [
  "instance.read",
  "instance.update",
  "save.create",
  "save.read",
  "save.update",
  "save.delete",
  "room.manage",
  "members.manage",
  "mods.manage",
  "players.manage",
  "bots.private.create",
  "bots.shared.create",
  "bots.manage",
  "bots.approve",
  "models.approve"
] as const;
export type CatalogPermission = (typeof CATALOG_PERMISSIONS)[number];
export const SERVER_LOADERS = ["vanilla", "paper", "fabric", "forge", "neoforge"] as const;
export type ServerLoader = (typeof SERVER_LOADERS)[number];
export interface CatalogActor {
  id: string;
  name: string;
  admin: boolean;
}
export interface AccessGrant {
  userId: string;
  scope: string;
  permissions: CatalogPermission[];
  hosting: boolean;
}
export interface ModEntry {
  name: string;
  version: string;
  file: string;
  sha256: string;
  side: "server" | "both";
}
export interface LaunchSettings {
  windowTitle: string; launcherInfo: string;
  windowMode: "default" | "windowed" | "maximized" | "fullscreen";
  width: number; height: number;
  memoryMode: "auto" | "manual"; memoryOptimization: boolean;
  javaRange: string; jvmArgs: string; gameArgs: string;
  gc: "default" | "serial" | "parallel" | "g1" | "zgc";
  autoJoin: string; downloadSource: "auto" | "official" | "mirror";
  assets: "default" | "verify"; disableJLW: boolean; disableLUA: boolean;
}
export const DEFAULT_LAUNCH: LaunchSettings = {
  windowTitle: "", launcherInfo: "", windowMode: "default", width: 854, height: 480,
  memoryMode: "auto", memoryOptimization: false, javaRange: "", jvmArgs: "", gameArgs: "",
  gc: "default", autoJoin: "", downloadSource: "auto", assets: "default", disableJLW: false, disableLUA: false
};
export interface InstallSelection {
  minecraft: string; forge: string; neoforge: string; fabric: string;
  fabricApi: string; optifine: string; optifabric: string; liteloader: string;
}
export const DEFAULT_INSTALL: InstallSelection = {minecraft: "", forge: "", neoforge: "", fabric: "", fabricApi: "", optifine: "", optifabric: "", liteloader: ""};
export interface InstallChoice { id: string; label: string; stable: boolean; requiredForge?: string | null; }
export interface ServerSettings {
  type: ServerLoader; version: string; javaMajor: number; memoryMb: number;
  jvmArgs: string; port: number; onlineMode: boolean; eulaAccepted: boolean;
  motd: string; allowFlight: boolean; enableCommandBlock: boolean;
}
export const DEFAULT_SERVER: ServerSettings = {type: "vanilla", version: "", javaMajor: 21, memoryMb: 4096, jvmArgs: "", port: 25565, onlineMode: true, eulaAccepted: false, motd: "NomadCraft", allowFlight: false, enableCommandBlock: false};
export interface ServerArtifact {
  url: string; fileName: string; size?: number; sha1?: string; sha256?: string;
  kind: "jar" | "installer"; installArgs: string[]; launchArgs: string[];
}
export interface RuntimeProfile {
  launch?: LaunchSettings;
  mcVersion: string;
  loader: ServerLoader;
  loaderVersion: string;
  packName: string;
  packRevision: string;
  javaMajor: number;
  memoryMb: number;
  artifact: string;
  artifactSha256: string;
}
export interface WorldRules {
  seed: string;
  gameMode: "survival" | "creative" | "adventure" | "spectator";
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  maxPlayers: number;
  viewDistance: number;
  simulationDistance: number;
  pvp: boolean;
  hardcore: boolean;
  whitelist: boolean;
}
export interface PlayerRule {
  uuid: string;
  name: string;
  access: "allowed" | "banned";
  opLevel: number;
}
export interface CatalogRoom {
  id: string;
  name: string;
  desiredState: "open" | "closed";
  createdAt: number;
}
export interface PublishedRelease {
  manifest?: import('./nomad-distribution').DistributionManifest;
  manifestDigest?: string;
  lineage?: {serviceId:string;instanceId:string;releaseId:string;digest:string};
  id: string;
  format: "modrinth" | "curseforge" | "pcl";
  install?: InstallSelection;
  server?: ServerSettings;
  serverArtifact?: ServerArtifact;
  source: "upload" | "official";
  fileName: string;
  sha256: string;
  size: number;
  profile: RuntimeProfile;
  publishedAt: number;
  publishedBy: string;
  fileCount: number;
}
export interface CatalogSave {
  gateway?: {enabled:boolean;backendPort:number};
  placement?:PlacementPolicy;
  ingress?:NetworkIngress;
  hosting?: HostingView | null;
  hostingAllowed?: boolean;
  releaseId?: string | null;
  id: string;
  name: string;
  description: string;
  rules: WorldRules;
  players: PlayerRule[];
  room: CatalogRoom | null;
  createdAt: number;
  updatedAt: number;
}
export interface CatalogEvent {
  id: string;
  at: number;
  actor: string;
  actorId: string;
  action: string;
  saveId: string | null;
}
export interface LogicalInstance {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  profile: RuntimeProfile;
  releases?: PublishedRelease[];
  mods: ModEntry[];
  grants: AccessGrant[];
  saves: CatalogSave[];
  events: CatalogEvent[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export interface InstanceView extends Omit<LogicalInstance, "grants"> {
  grants: AccessGrant[];
  permissions: CatalogPermission[];
  savePermissions: Record<string, CatalogPermission[]>;
  hostingScopes: string[];
}
export interface CatalogResponse {
  instances: InstanceView[];
  canCreate: boolean;
  creatorIds?: string[];
}
export interface CatalogUser {
  id: string;
  name: string;
}
export interface InstanceInput {
  name: string;
  description: string;
  profile: RuntimeProfile;
}
export interface SaveInput {
  name: string;
  description: string;
  rules: WorldRules;
}
export const DEFAULT_PROFILE: RuntimeProfile = {
  mcVersion: "",
  loader: "vanilla",
  loaderVersion: "",
  packName: "",
  packRevision: "",
  javaMajor: 21,
  memoryMb: 4096,
  artifact: "",
  artifactSha256: ""
};
export const DEFAULT_RULES: WorldRules = {
  seed: "",
  gameMode: "survival",
  difficulty: "normal",
  maxPlayers: 10,
  viewDistance: 10,
  simulationDistance: 10,
  pvp: true,
  hardcore: false,
  whitelist: true
};
