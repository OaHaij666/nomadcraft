import crypto from "crypto";
import { CatalogError } from "./nomad_catalog";
interface Job {
  id: string;
  action: string;
  args: Record<string, unknown>;
  epoch?: number;
  claimed?: boolean;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Control-plane to current compute host. Credentials never cross this transport. */
export class NomadBotTransport {
  private jobs = new Map<string, Job[]>();
  private hosts = new Map<
    string,
    { epoch: number; seen: number; roster: any[]; ready: boolean; error?: string }
  >();
  key(instanceId: string, saveId: string) {
    return instanceId + ":" + saveId;
  }
  status(instanceId: string, saveId: string) {
    const host = this.hosts.get(this.key(instanceId, saveId));
    return host && Date.now() - host.seen < 10000
      ? host
      : { ready: false, roster: [], error: "bot_host_offline" };
  }
  offline(instanceId: string, saveId: string, epoch: number): boolean {
    const key = this.key(instanceId, saveId), host = this.hosts.get(key);
    if (!host || host.epoch !== epoch) return false;
    this.hosts.set(key, { ...host, ready: false, roster: [], seen: Date.now(), error: "bot_host_offline" });
    for (const job of [...(this.jobs.get(key) ?? [])]) job.reject(new Error("bot_host_offline_outcome_unknown"));
    return true;
  }
  call(
    instanceId: string,
    saveId: string,
    action: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const key = this.key(instanceId, saveId),
      host = this.status(instanceId, saveId);
    if (!host.ready)
      return Promise.reject(new CatalogError(409, host.error || "bot_adapter_required"));
    if ((this.jobs.get(key)?.length ?? 0) >= 100)
      return Promise.reject(new CatalogError(429, "bot_transport_full"));
    if (signal?.aborted) return Promise.reject(new Error("bot_request_cancelled"));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let job: Job;
      const cleanup = () => {
        const list = this.jobs.get(key);
        if (list)
          this.jobs.set(
            key,
            list.filter((item) => item.id !== id),
          );
        clearTimeout(job.timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error("bot_request_cancelled"));
      };
      job = {
        id,
        action,
        args,
        epoch: (host as any).epoch,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          cleanup();
          reject(new Error("bot_request_timeout_outcome_unknown"));
        }, 120000),
      };
      job.timer.unref();
      this.jobs.set(key, [...(this.jobs.get(key) ?? []), job]);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  poll(instanceId: string, saveId: string, epoch: number, report: any) {
    const key = this.key(instanceId, saveId);
    const old = this.hosts.get(key);
    if (old && old.epoch !== epoch) {
      for (const job of [...(this.jobs.get(key) ?? [])])
        job.reject(new Error("bot_host_changed_outcome_unknown"));
    }
    const roster = Array.isArray(report?.roster)
      ? report.roster
          .slice(0, 100)
          .filter(
            (b: any) =>
              typeof b?.id === "string" &&
              /^[0-9a-f-]{36}$/i.test(b.id) &&
              typeof b.name === "string",
          )
          .map((b: any) => ({ id: b.id, name: b.name, owner: b.owner, online: b.online === true }))
      : [];
    this.hosts.set(key, {
      epoch,
      seen: Date.now(),
      ready: report?.ready === true,
      roster,
      error: report?.ready === true ? undefined : "bot_adapter_required",
    });
    return (this.jobs.get(key) ?? [])
      .filter((job) => !job.claimed && job.epoch === epoch)
      .slice(0, 10)
      .map((job) => {
        job.claimed = true;
        return { id: job.id, action: job.action, args: job.args };
      });
  }
  complete(instanceId: string, saveId: string, epoch: number, id: string, result: any) {
    const job = (this.jobs.get(this.key(instanceId, saveId)) ?? []).find((job) => job.id === id);
    if (!job || job.epoch !== epoch || !job.claimed)
      throw new CatalogError(409, "bot_request_expired");
    if (JSON.stringify(result).length > 1024 * 1024)
      throw new CatalogError(413, "bot_receipt_too_large");
    if (result?.ok === true) job.resolve(result.result);
    else job.reject(new Error("bot_adapter_operation_failed"));
    return { accepted: true };
  }
}
export const nomadBotTransport = new NomadBotTransport();
