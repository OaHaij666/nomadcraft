import {
  NODE_ONLINE_MS,
  type ComputeNode,
  type PlacementPolicy
} from "../../../../shared/nomad-compute";
import type { HostingWillingness } from "../../../../shared/nomad-hosting-preference";
export interface Candidate {
  node: ComputeNode;
  willingness: HostingWillingness;
  busyMemoryMb: number;
  activeTasks: number;
  authorized: boolean;
}
export function selectComputeNode(
  policy: PlacementPolicy,
  candidates: Candidate[],
  memoryMb: number,
  now = Date.now()
): ComputeNode | null {
  const eligible = candidates.filter(
    (c) =>
      c.authorized &&
      c.node.enabled &&
      c.node.lastSeenAt + NODE_ONLINE_MS > now &&
      c.node.metrics &&
      c.node.metrics.cpuCores >= 1 &&
      c.activeTasks < c.node.maxTasks &&
      c.busyMemoryMb + memoryMb + 512 <= c.node.memoryBudgetMb &&
      c.node.metrics.availableMemoryMb >= memoryMb + 512 + c.node.reserveMemoryMb &&
      (c.node.kind !== "player" || c.willingness !== "none")
  );
  if (policy.mode === "manual") return null;
  if (policy.mode === "fixed")
    return eligible.find((c) => c.node.id === policy.nodeId)?.node ?? null;
  let pool = eligible;
  if (policy.mode === "fallback") {
    const players = eligible.filter((c) => c.node.kind === "player");
    pool = players.length
      ? players
      : eligible.filter(
          (c) => c.node.kind === "server" && (!policy.nodeId || c.node.id === policy.nodeId)
        );
  }
  const score = (c: Candidate) =>
    c.node.priority * 10 +
    (c.node.kind === "server"
      ? 10
      : c.willingness === "high"
      ? 20
      : c.willingness === "low"
      ? -20
      : 0) +
    Math.min(c.node.metrics!.cpuCores, 16) +
    Math.min(c.node.metrics!.availableMemoryMb / 1024, 16);
  pool.sort((a, b) => score(b) - score(a) || a.node.id.localeCompare(b.node.id));
  return pool[0]?.node ?? null;
}
