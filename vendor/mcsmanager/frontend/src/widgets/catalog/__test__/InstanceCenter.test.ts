// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstanceCenter from "../InstanceCenter.vue";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  users: vi.fn(),
  creators: vi.fn(),
  push: vi.fn()
}));
const admin = ref(false);
vi.mock("@/config/router", () => ({ router: { push: mocks.push } }));
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ isAdmin: admin }) }));
vi.mock("@/services/apis/catalog", async (importActual) => {
  const actual: any = await importActual();
  return { ...actual, catalogApi: { ...actual.catalogApi, ...mocks } };
});
const profile = {
  mcVersion: "1.20.1",
  loader: "fabric",
  loaderVersion: "0.16",
  packName: "Friends pack",
  packRevision: "v1",
  javaMajor: 17,
  memoryMb: 4096,
  artifact: "server.zip",
  artifactSha256: ""
};
const instance = {
  id: "logical-one",
  name: "Friends",
  description: "",
  ownerId: "owner",
  ownerName: "Owner",
  profile,
  mods: [],
  grants: [],
  saves: [],
  events: [],
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  permissions: ["instance.read"],
  savePermissions: {},
  hostingScopes: []
};
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.clearAllMocks();
  admin.value = false;
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
  mocks.list.mockResolvedValue({ instances: [instance], canCreate: false });
  mocks.create.mockResolvedValue({ id: "created" });
});
afterEach(() => wrapper?.unmount());
const render = async () => {
  wrapper = mount(InstanceCenter);
  await flushPromises();
};
describe("logical instance center", () => {
  it("renders centrally stored versions and routes to their logical identity", async () => {
    await render();
    expect(wrapper.text()).toContain("1.20.1");
    expect(wrapper.text()).toContain("Friends pack");
    await wrapper.find(".instance-name").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/catalog/detail",
      query: { id: "logical-one" }
    });
  });
  it("does not expose creation or creation grants to an unauthorized user", async () => {
    await render();
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("TXT_CODE_CATALOG_NEW_INSTANCE"))
    ).toBe(false);
    expect(wrapper.text()).not.toContain("TXT_CODE_CATALOG_CREATE_PERMISSIONS");
  });
  it("authorized creation sends a profile without selecting a host", async () => {
    mocks.list.mockResolvedValue({ instances: [], canCreate: true });
    await render();
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_CATALOG_NEW_INSTANCE"))!
      .trigger("click");
    await flushPromises();
    Array.from(document.querySelectorAll('[role="tab"]')).find(b => b.textContent?.includes("TXT_CODE_CATALOG_PROFILE_ONLY"))!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    await flushPromises();
    const form = wrapper.findComponent({ name: "InstanceEditor" });
    form.vm.$emit("submit", { name: "New", description: "", profile });
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith({ name: "New", description: "", profile });
    expect(mocks.push).toHaveBeenCalledWith({ path: "/catalog/detail", query: { id: "created" } });
  });
  it("shows a backend failure and never replaces it with an empty-success state", async () => {
    mocks.list.mockRejectedValue(new Error("connection failed"));
    await render();
    expect(wrapper.text()).toContain("TXT_CODE_CATALOG_ERROR_request_failed");
    expect(wrapper.text()).not.toContain("TXT_CODE_CATALOG_NO_INSTANCES");
  });
});
