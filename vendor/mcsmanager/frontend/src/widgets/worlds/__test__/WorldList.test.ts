// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import WorldList from "../WorldList.vue";
const mocks = vi.hoisted(() => ({
  nodes: vi.fn(),
  instances: vi.fn(),
  user: vi.fn(),
  push: vi.fn()
}));
const admin = ref(true);
vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ isAdmin: admin }) }));
vi.mock("@/services/apis", () => ({
  remoteNodeList: () => ({ execute: mocks.nodes }),
  remoteInstances: () => ({ execute: mocks.instances }),
  userInfoApi: () => ({ execute: mocks.user })
}));
vi.mock("@/config/router", () => ({ router: { push: mocks.push } }));
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/widgets/instance/Shortcut.vue", () => ({
  default: {
    props: ["targetInstanceInfo"],
    template: '<div class="test-world">{{ targetInstanceInfo.config.nickname }}</div>'
  }
}));
const node = { uuid: "host-a", ip: "localhost", remarks: "Host A", available: true, port: 24444 };
const card = {
  id: "worlds",
  type: "InstanceList",
  title: "Worlds",
  width: 12,
  height: "unset",
  meta: {}
};
const world = (id: string, name: string) => ({
  instanceUuid: id,
  status: 0,
  config: { nickname: name },
  info: {}
});
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.clearAllMocks();
  admin.value = true;
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
  mocks.nodes.mockResolvedValue({ value: [node] });
  mocks.instances.mockResolvedValue({
    value: { data: [world("w1", "Real save")], page: 1, maxPage: 1 }
  });
  mocks.user.mockResolvedValue({
    value: {
      instances: [
        { daemonId: "host-a", instanceUuid: "assigned", nickname: "Assigned save", status: 0 }
      ]
    }
  });
});
afterEach(() => wrapper?.unmount());
const render = async () => {
  wrapper = mount(WorldList, { props: { card } });
  await flushPromises();
};
describe("world list access and loading", () => {
  it("shows real host worlds and sends search filters to the daemon", async () => {
    await render();
    expect(wrapper.text()).toContain("Real save");
    expect(mocks.instances).toHaveBeenCalledWith({
      params: { daemonId: "host-a", page: 1, page_size: 20, instance_name: "", status: "" }
    });
    await wrapper.find("input").setValue("modded");
    await wrapper.find("input").trigger("keydown", { key: "Enter", keyCode: 13 });
    await flushPromises();
    expect(mocks.instances.mock.calls.at(-1)?.[0].params.instance_name).toBe("modded");
  });
  it("uses only the assigned-world endpoint for regular players", async () => {
    admin.value = false;
    await render();
    expect(wrapper.text()).toContain("Assigned save");
    expect(wrapper.text()).not.toContain("TXT_CODE_WORLD_CREATE");
    expect(mocks.nodes).not.toHaveBeenCalled();
    expect(mocks.instances).not.toHaveBeenCalled();
    expect(mocks.user).toHaveBeenCalledWith({ params: { advanced: true } });
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_WORLD_OPEN"))!
      .trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/instances/terminal",
      query: { daemonId: "host-a", instanceId: "assigned" }
    });
  });
  it("reports an inaccessible host without pretending it has no worlds", async () => {
    mocks.instances.mockRejectedValue(new Error("Host unavailable"));
    await render();
    expect(wrapper.text()).toContain("TXT_CODE_WORLD_HOST_UNAVAILABLE");
    expect(wrapper.text()).not.toContain("TXT_CODE_WORLD_EMPTY");
  });
  it("loads later pages without dropping or duplicating existing worlds", async () => {
    mocks.instances
      .mockResolvedValueOnce({ value: { data: [world("w1", "First save")], page: 1, maxPage: 2 } })
      .mockResolvedValueOnce({
        value: {
          data: [world("w1", "First save"), world("w2", "Second save")],
          page: 2,
          maxPage: 2
        }
      });
    await render();
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_101ef36f"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".test-world").map((w) => w.text())).toEqual([
      "First save",
      "Second save"
    ]);
  });
});
