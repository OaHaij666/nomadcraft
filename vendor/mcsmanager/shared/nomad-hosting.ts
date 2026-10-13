import type {ComputeNode} from "./nomad-compute";
import type { CatalogActor } from "./nomad-catalog";
export type HostPhase = "starting" | "ready" | "checkpointing" | "stopping" | "stopped" | "failed";
export interface WorldCheckpoint {sha256:string; size:number; at:number; epoch:number; final?:boolean;}
export interface HostHandover {id:string;targetNodeId:string;requestedAt:number;requestedBy:string;phase:"saving"|"restoring"|"completed";sourceEpoch:number;checkpointEpoch?:number;}
export interface HostingView {handover?:HostHandover;phase:HostPhase; epoch:number; nodeName:string; holderName:string; leaseExpiresAt:number; joinAddress:string | null; checkpoint:WorldCheckpoint | null; error:string;}
export interface ExecutorGrant {id:string; tokenHash:string; actor:CatalogActor; instanceId:string; saveId:string; nodeName:string; expiresAt:number;nodeId?:string;}
export interface HostLease extends HostingView {grantId:string;instanceId:string;saveId:string;stopDeadlineAt?:number;}
export const HOST_LEASE_MS = 90000;
export const HOST_FENCE_GRACE_MS = 20000;
export const HOST_FINAL_SAVE_MS = 10 * 60 * 1000;
export interface HostingState {grants:ExecutorGrant[]; leases:HostLease[];nodes?:ComputeNode[];}
