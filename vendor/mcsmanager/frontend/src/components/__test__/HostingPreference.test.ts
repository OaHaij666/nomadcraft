// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { reactive, ref } from "vue";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import HostingPreference from "../HostingPreference.vue";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), success: vi.fn() }));
const state = reactive({ userInfo: { hostingWillingness: "medium" } });
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ state }) }));
vi.mock("@/services/apis/user", () => ({
  getHostingPreference: () => ({ execute: mocks.get }),
  setHostingPreference: () => ({ execute: mocks.save })
}));
vi.mock("ant-design-vue", async (original) => ({
  ...(await original<any>()),
  message: { success: mocks.success }
}));
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.clearAllMocks();
  state.userInfo.hostingWillingness = "medium";
  mocks.get.mockResolvedValue(ref({ hostingWillingness: "medium" }));
  mocks.save.mockImplementation(async ({ data }) => ref(data));
});
afterEach(() => wrapper?.unmount());
async function render() {
  wrapper = mount(HostingPreference);
  await flushPromises();
}
async function select(value: string) {
  await wrapper.find('input[value="' + value + '"]').setValue(true);
}
describe("personal hosting willingness", () => {
  it("shows all four choices with medium selected and no dirty save by default", async () => {
    await render();
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(4);
    expect((wrapper.find('input[value="medium"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
  });
  it("saves none on the account and restores it when the settings are reopened", async () => {
    await render();
    await select("none");
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(mocks.save).toHaveBeenCalledWith({
      data: { hostingWillingness: "none" },
      forceRequest: true
    });
    expect(state.userInfo.hostingWillingness).toBe("none");
    wrapper.unmount();
    mocks.get.mockResolvedValue(ref({ hostingWillingness: "none" }));
    await render();
    expect((wrapper.find('input[value="none"]').element as HTMLInputElement).checked).toBe(true);
  });
  it("keeps the user's choice on save failure and allows retry", async () => {
    mocks.save.mockRejectedValueOnce(new Error("offline"));
    await render();
    await select("low");
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("TXT_CODE_HOSTING_PREF_SAVE_ERROR");
    expect((wrapper.find('input[value="low"]').element as HTMLInputElement).checked).toBe(true);
    expect(state.userInfo.hostingWillingness).toBe("medium");
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(state.userInfo.hostingWillingness).toBe("low");
  });
  it("does not present a failed load as a usable default and supports retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(wrapper.text()).toContain("TXT_CODE_HOSTING_PREF_LOAD_ERROR");
    expect(
      wrapper
        .findAll('input[type="radio"]')
        .every((input) => (input.element as HTMLInputElement).disabled)
    ).toBe(true);
    await wrapper.findAll("button")[1].trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("TXT_CODE_HOSTING_PREF_LOAD_ERROR");
    expect((wrapper.find('input[value="medium"]').element as HTMLInputElement).disabled).toBe(
      false
    );
  });
});
