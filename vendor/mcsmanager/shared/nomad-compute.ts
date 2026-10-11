export type ComputeKind = "server" | "player";
export interface NodeMetrics {
  cpuCores: number;
  totalMemoryMb: number;
  availableMemoryMb: number;
}
export interface ComputeNode {
  id: string;
  name: string;
  kind: ComputeKind;
  ownerId: string;
  ownerName: string;
  enabled: boolean;
  priority: number;
  memoryBudgetMb: number;
  reserveMemoryMb: number;
  maxTasks: number;
  allowAllInstances: boolean;
  allowedInstanceIds: string[];
  lastSeenAt: number;
  metrics: NodeMetrics | null;
  lastError: string;
  tokenHash: string;
}
export interface ComputeNodeView extends Omit<ComputeNode, "tokenHash"> {
  online: boolean;
  activeTasks: number;
}
export interface NodeCredential {
  panel: string;
  nodeId: string;
  token: string;
}
export interface PlacementPolicy {
  mode: "manual" | "fixed" | "auto" | "fallback";
  nodeId: string | null;
}
export const DEFAULT_PLACEMENT: PlacementPolicy = { mode: "manual", nodeId: null };
export interface NetworkIngress {
  kind: "direct" | "generic-tcp" | "frp" | "private-network" | "client-assisted";
  bindHost: string;
  bindPort: number;
  publicHost: string;
  publicPort: number;
  family: "auto" | "ipv4" | "ipv6";
  tunnelHost: string;
  tunnelPort: number;
}
export interface NetworkCheck {
  key: string;
  status: "ok" | "warning" | "failed" | "unverified";
  message: string;
  address?: string;
  family?: number;
  latencyMs?: number;
  protocol?: number;
  version?: string;
}
export interface NetworkReport {
  at: number;
  vantage: "center";
  publicReachability: "unverified";
  interfaces: { name: string; address: string; family: string; internal: boolean }[];
  checks: NetworkCheck[];
}
export const NODE_ONLINE_MS = 20000;
