import { clientRelease } from "./cloudPreparePlan";
import { getSettings } from "./settings";
import { centerTarget } from "./instanceCenter";
import { baseline, inventory, pendingJournal } from "./cloudSyncFiles";
import {
  diffManifest,
  manifestDigest,
  type DistributionManifest,
} from "../../../../mcsmanager/shared/nomad-distribution";
export async function attachLocalStatus(instances: any[], serviceId: string) {
  for (const instance of instances) {
    const scopes = [
      {
        saveId: undefined as string | undefined,
        object: instance,
        release: instance.releases?.slice(-1)[0],
      },
      ...(instance.saves ?? []).map((save: any) => ({
        saveId: save.id,
        object: save,
        release: instance.releases?.find((r: any) => r.id === save.releaseId),
      })),
    ];
    for (const scope of scopes) {
      const key = JSON.stringify([
          serviceId,
          instance.id,
          scope.saveId || "instance",
        ]),
        binding = getSettings().cloudInstanceBindings?.[key];
      if (!binding?.localVersionId) {
        scope.object.sync = { state: "unbound" };
        continue;
      }
      try {
        const c = centerTarget({
          id: binding.localVersionId,
          folder: binding.localFolder,
        });
        const j = await pendingJournal(c.dir);
        if (j?.state === "applying") {
          scope.object.sync = {
            state: "conflict",
            message: "同步事务需要恢复",
          };
          continue;
        }
        const old = await baseline(c.dir),
          next = clientRelease(scope.release)?.manifest as DistributionManifest | undefined;
        if (!next || !old) {
          scope.object.sync = { state: "checking" };
          continue;
        }
        if (old.serviceId !== serviceId || old.instanceId !== instance.id) {
          scope.object.sync = {
            state: "conflict",
            message: "本地目录已同步其它实例",
          };
          continue;
        }
        const merged: DistributionManifest = {
          schema: 1,
          files: [
            ...new Map(
              [...old.manifest.files, ...next.files].map((f) => [f.path, f]),
            ).values(),
          ],
        };
        const current = await inventory(c.dir, merged),
          diff = diffManifest(old.manifest, next, current);
        scope.object.sync = {
          state: diff.some((d) => d.conflict)
            ? "conflict"
            : old.releaseId !== scope.release.id || old.digest !== manifestDigest(next)
              ? "cloud-ahead"
              : diff.some((d) => d.operation !== "same")
                ? "local-ahead"
                : "synced",
        };
      } catch {
        scope.object.sync = {
          state: "unbound",
          message: "绑定的客户端目录不可用",
        };
      }
    }
  }
}
