// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import ComputeNodes from "../ComputeNodes.vue";
const mocks = vi.hoisted(() => ({
  nodes: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  serverCheck: vi.fn(),
  download: vi.fn()
}));
const admin = ref(false);
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ isAdmin: admin }) }));
vi.mock("@/services/apis/compute", () => ({ computeApi: mocks, downloadText: mocks.download }));
let wrapper: ReturnType<typeof mount>;
const node = {
  id: "node",
  name: "Player PC",
  kind: "player",
  ownerName: "Owner",
  online: true,
  enabled: true,
  priority: 0,
  memoryBudgetMb: 4096,
  reserveMemoryMb: 512,
  maxTasks: 1,
  allowAllInstances: true,
  allowedInstanceIds: [],
  activeTasks: 0,
  metrics: { cpuCores: 4, availableMemoryMb: 8000 },
  lastError: ""
};
beforeEach(() => {
  vi.clearAllMocks();
  admin.value = false;
  mocks.nodes.mockResolvedValue([structuredClone(node)]);
  mocks.update.mockResolvedValue({});
  mocks.serverCheck.mockResolvedValue({at:1,vantage:"center",publicReachability:"unverified",interfaces:[],checks:[{key:"external",status:"unverified",message:"external_probe_required"}]});
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {}
    })
  });
});
afterEach(() => wrapper?.unmount());
async function render() {
  wrapper = mount(ComputeNodes);
  await flushPromises();
}
describe("paired compute nodes", () => {
  it("shows resource state without giving a player administrator priority controls", async () => {
    await render();
    expect(wrapper.text()).toContain("Player PC");
    expect(wrapper.text()).toContain("8000 MiB");
    expect(wrapper.text()).not.toContain("TXT_CODE_COMPUTE_PRIORITY");
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_COMPUTE_SAVE"))!
      .trigger("click");
    await flushPromises();
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty("priority");
  });
  it("offers a center network check without claiming public reachability",async()=>{admin.value=true;await render();await wrapper.findAll("button").find(b=>b.text().includes("TXT_CODE_COMPUTE_SERVER_CHECK"))!.trigger("click");await flushPromises();expect(mocks.serverCheck).toHaveBeenCalled();expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_NETWORK_EXTERNAL_PROBE_REQUIRED");});
  it("offers priority only to administrators", async () => {
    admin.value = true;
    await render();
    expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_PRIORITY");
  });
});
