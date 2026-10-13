import { useDefineApi } from "@/stores/useDefineApi";
import type {
  ComputeNodeView,
  NetworkReport,
  PlacementPolicy,
  NetworkIngress
} from "../../../../shared/nomad-compute";
const list = useDefineApi<{ params?: { instanceId?: string } }, ComputeNodeView[]>({
  url: "/api/nomad/hosting/nodes",
  method: "GET"
});
const create = useDefineApi<
  { data: any },
  { node: ComputeNodeView; credential: { nodeId: string; token: string } }
>({ url: "/api/nomad/hosting/nodes", method: "POST" });
const update = useDefineApi<{ data: any }, ComputeNodeView>({ method: "PUT" });
const runtime = useDefineApi<
  { data: { placement: PlacementPolicy; ingress?: NetworkIngress | null; gateway?:{enabled:boolean;backendPort:number}|null } },
  any
>({ method: "PUT" });
const check = useDefineApi<{}, NetworkReport>({ method: "POST" });
const frp = useDefineApi<{}, { configuration: string }>({ method: "GET" });
export const computeApi = {
  async nodes(instanceId?: string) {
    return (
      (
        await list().execute({
          params: instanceId ? { instanceId } : undefined,
          forceRequest: true
        })
      ).value ?? []
    );
  },
  async create(data: any) {
    return (await create().execute({ data, forceRequest: true })).value!;
  },
  async update(id: string, data: any) {
    return (
      await update().execute({ url: "/api/nomad/hosting/nodes/" + id, data, forceRequest: true })
    ).value!;
  },
  async runtime(
    instanceId: string,
    saveId: string,
    data: { placement: PlacementPolicy; ingress?: NetworkIngress | null; gateway?:{enabled:boolean;backendPort:number}|null }
  ) {
    return (
      await runtime().execute({
        url: "/api/nomad/hosting/runtime/" + instanceId + "/" + saveId,
        data,
        forceRequest: true
      })
    ).value;
  },
  async serverCheck() {
    return (await check().execute({ url: "/api/nomad/hosting/network/check", forceRequest: true }))
      .value!;
  },
  async check(instanceId: string, saveId: string) {
    return (
      await check().execute({
        url: "/api/nomad/hosting/network/" + instanceId + "/" + saveId + "/check",
        forceRequest: true
      })
    ).value!;
  },
  async frp(instanceId: string, saveId: string) {
    return (
      await frp().execute({
        url: "/api/nomad/hosting/network/" + instanceId + "/" + saveId + "/frp",
        forceRequest: true
      })
    ).value!.configuration;
  }
};
export function downloadText(fileName: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
