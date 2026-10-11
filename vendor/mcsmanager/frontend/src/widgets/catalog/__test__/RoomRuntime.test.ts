// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import RoomRuntime from "../RoomRuntime.vue";
const mocks = vi.hoisted(() => ({
  nodes: vi.fn(),
  runtime: vi.fn(),
  check: vi.fn(),
  frp: vi.fn()
}));
const admin = ref(true);
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ isAdmin: admin }) }));
vi.mock("@/services/apis/compute", () => ({ computeApi: mocks, downloadText: vi.fn() }));
let wrapper: ReturnType<typeof mount>;
const save = {
  id: "save",
  name: "World",
  room: { desiredState: "closed" },
  placement: { mode: "fixed", nodeId: "node" },
  ingress: {
    kind: "generic-tcp",
    bindHost: "127.0.0.1",
    bindPort: 25565,
    publicHost: "edge.example.com",
    publicPort: 30065,
    family: "auto",
    tunnelHost: "",
    tunnelPort: 0
  }
};
beforeEach(() => {
  vi.clearAllMocks();
  admin.value = true;
  mocks.nodes.mockResolvedValue([{ id: "node", name: "Server", kind: "server", online: true }]);
  mocks.runtime.mockResolvedValue({});
  mocks.check.mockResolvedValue({
    at: 1,
    vantage: "center",
    publicReachability: "unverified",
    interfaces: [],
    checks: [
      {
        key: "minecraft",
        status: "ok",
        message: "minecraft_status_reachable_from_center",
        address: "127.0.0.1:30065",
        protocol: 763
      },
      { key: "external", status: "unverified", message: "external_probe_required" }
    ]
  });
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
async function render(value: any = save) {
  wrapper = mount(RoomRuntime, { props: { instanceId: "instance", save: value } });
  await flushPromises();
}
describe("room placement and network settings", () => {
  it("saves distinct local and advertised ports with fixed node identity", async () => {
    await render();
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_COMPUTE_SAVE"))!
      .trigger("click");
    await flushPromises();
    expect(mocks.runtime).toHaveBeenCalledWith("instance", "save", {
      placement: { mode: "fixed", nodeId: "node" },
      ingress: save.ingress
    });
    expect(wrapper.emitted("done")).toHaveLength(1);
  });
  it("shows center-only results without turning public reachability green", async () => {
    await render();
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_COMPUTE_CHECK"))!
      .trigger("click");
    await flushPromises();
    expect(mocks.check).toHaveBeenCalledWith("instance", "save");
    expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_EXTERNAL_NOTE");
    expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_CHECK_UNVERIFIED");
    expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_NETWORK_EXTERNAL_PROBE_REQUIRED");
  });
  it("lets room managers choose placement without exposing administrative network checks", async () => {
    admin.value = false;
    await render();
    expect(wrapper.text()).not.toContain("TXT_CODE_COMPUTE_BIND_PORT");
    expect(wrapper.text()).not.toContain("TXT_CODE_COMPUTE_CHECK");
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_COMPUTE_SAVE"))!
      .trigger("click");
    await flushPromises();
    expect(mocks.runtime).toHaveBeenCalledWith("instance", "save", {
      placement: { mode: "fixed", nodeId: "node" }
    });
  });
  it("requires closing an active room before configuration changes", async () => {
    await render({ ...save, room: { desiredState: "open" } });
    const button = wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_COMPUTE_SAVE"))!;
    expect(button.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("TXT_CODE_COMPUTE_CLOSE_FIRST");
  });
});
