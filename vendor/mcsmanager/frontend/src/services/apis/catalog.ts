import axios from "axios";
import { apiService } from "@/services/apiService";
import type {
  AccessGrant,
  CatalogResponse,
  CatalogSave,
  CatalogUser,
  InstanceInput,
  ModEntry,
  PlayerRule,
  SaveInput
} from "../../../../shared/nomad-catalog";
export type {
  AccessGrant,
  CatalogPermission,
  CatalogResponse,
  CatalogSave,
  CatalogUser,
  InstanceInput,
  InstanceView,
  ModEntry,
  PlayerRule,
  RuntimeProfile,
  SaveInput,
  WorldRules
} from "../../../../shared/nomad-catalog";
export {
  CATALOG_PERMISSIONS,
  DEFAULT_PROFILE,
  DEFAULT_RULES,
  SERVER_LOADERS
} from "../../../../shared/nomad-catalog";
const base = "/api/nomad/catalog";
async function request<T>(method: string, route: string, data?: unknown): Promise<T> {
  const result = await apiService.subscribe<T>({
    method,
    url: base + route,
    data,
    timeout: data instanceof FormData ? 0 : 60000,
    forceRequest: true
  });
  if (result === undefined || result === null) throw new Error("empty_catalog_response");
  return result;
}
export const catalogApi = {
  policy: () => request<{maxGiB: number; maxBytes: number; maxExpandedBytes: number}>("GET", "/policy"),
  officialVersions: () => request<Array<{id: string; releasedAt: string}>>("GET", "/official-versions"),
  components: (component: string, minecraft: string) => request<import("../../../../shared/nomad-catalog").InstallChoice[]>("GET", "/components/" + component + "?minecraft=" + encodeURIComponent(minecraft)),
  official: (version: string, name: string, instanceId?: string, options?: unknown) => request<{id: string}>("POST", "/official", {version, name, instanceId, ...(options as any)}),
  import: (file: File, name: string, instanceId?: string, options?: {profile?: unknown; server?: unknown}) => {
    const form = new FormData(); form.append("package", file); form.append("name", name);
    if (options?.profile) form.append("profile", JSON.stringify(options.profile));
    if (options?.server) form.append("server", JSON.stringify(options.server));
    if (instanceId) form.append("instanceId", instanceId);
    return request<{id: string}>("POST", "/import" + (instanceId ? "?instanceId=" + encodeURIComponent(instanceId) : ""), form);
  },
  configureRelease: (id: string, releaseId: string, options: unknown) => request("POST", "/instances/" + id + "/releases/" + releaseId + "/configure", options),
  downloadServer: async (id: string, releaseId: string, saveId?: string) => {
    const response = await axios.get(base + "/instances/" + id + "/releases/" + releaseId + "/server", {params: {saveId}, responseType:"blob", timeout:0});
    const href = URL.createObjectURL(response.data), link = document.createElement("a"); link.href = href; link.download = "nomad-server-" + releaseId + ".zip"; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  },
  bindRelease: (id: string, saveId: string, releaseId: string) => request("PUT", "/instances/" + id + "/saves/" + saveId + "/release", {releaseId}),
  list: () => request<CatalogResponse>("GET", "/"),
  users: () => request<CatalogUser[]>("GET", "/users"),
  creators: (userIds: string[]) => request("PUT", "/creators", { userIds }),
  create: (data: InstanceInput) => request<{ id: string }>("POST", "/instances", data),
  update: (id: string, data: InstanceInput) => request("PUT", "/instances/" + id, data),
  clone: (id: string) => request<{ id: string }>("POST", "/instances/" + id + "/clone"),
  delete: (id: string) => request("DELETE", "/instances/" + id),
  save: (id: string, saveId: string | null, data: SaveInput) =>
    request<CatalogSave>(
      saveId ? "PUT" : "POST",
      "/instances/" + id + "/saves" + (saveId ? "/" + saveId : ""),
      data
    ),
  deleteSave: (id: string, saveId: string) =>
    request("DELETE", "/instances/" + id + "/saves/" + saveId),
  room: (
    id: string,
    saveId: string,
    data: { name: string; desiredState?: "open" | "closed" },
    create = false
  ) => request(create ? "POST" : "PUT", "/instances/" + id + "/saves/" + saveId + "/room", data),
  grants: (id: string, grants: AccessGrant[]) =>
    request("PUT", "/instances/" + id + "/grants", { grants }),
  mods: (id: string, mods: ModEntry[]) => request("PUT", "/instances/" + id + "/mods", { mods }),
  players: (id: string, saveId: string, players: PlayerRule[]) =>
    request("PUT", "/instances/" + id + "/saves/" + saveId + "/players", { players })
};
