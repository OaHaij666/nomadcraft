// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudImport from "../CloudImport.vue";
const mocks = vi.hoisted(() => ({import: vi.fn(), official: vi.fn(), officialVersions: vi.fn(), policy: vi.fn(), components: vi.fn(), error: vi.fn(), success: vi.fn()}));
vi.mock("@/lang/i18n", () => ({t: (key: string) => key}));
vi.mock("ant-design-vue", async importActual => ({...await importActual<any>(), message: {error: mocks.error, success: mocks.success}}));
vi.mock("@/services/apis/catalog", () => ({catalogApi: mocks}));
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  mocks.policy.mockResolvedValue({maxGiB:5, maxBytes:5 * 1024 ** 3});
  Object.defineProperty(window, "matchMedia", {configurable: true, value: () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}})});
});
afterEach(() => {wrapper?.unmount(); vi.clearAllMocks();});
async function fileSelected() {
  await flushPromises();
  const file = new File(["zip"], "friends.mrpack");
  const input = wrapper.find('input[type="file"]'); Object.defineProperty(input.element, "files", {value: [file]});
  await input.trigger("change"); await flushPromises(); return file;
}
async function submit() { await wrapper.find("form").trigger("submit"); await flushPromises(); }
describe("cloud modpack publication form", () => {
  it("requires a package and uploads it to create a logical cloud instance", async () => {
    mocks.import.mockResolvedValue({id: "created"}); wrapper = mount(CloudImport);
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
    const file = await fileSelected(); await submit();
    expect(mocks.import).toHaveBeenCalledWith(file, "", undefined, expect.objectContaining({profile:expect.any(Object)}));
    expect(wrapper.emitted("done")).toEqual([["created"]]);
  });
  it("publishes to the existing instance without changing its identity", async () => {
    mocks.import.mockResolvedValue({id: "release-id"}); wrapper = mount(CloudImport, {props: {instanceId: "logical-id"}});
    const file = await fileSelected(); await submit();
    expect(mocks.import).toHaveBeenCalledWith(file, "", "logical-id", expect.objectContaining({profile:expect.any(Object)}));
    expect(wrapper.emitted("done")).toEqual([["logical-id"]]);
  });
  it("shows current admin upload policy and rejects an oversized selection before uploading", async () => {
    mocks.policy.mockResolvedValue({maxGiB:8,maxBytes:8*1024**3});wrapper=mount(CloudImport);await flushPromises();
    expect(wrapper.text()).toContain("TXT_CODE_CATALOG_PACK_FORMAT_NOTE");
    const file=new File(["zip"],"huge.zip");Object.defineProperty(file,"size",{value:9*1024**3});
    const input=wrapper.find('input[type="file"]');Object.defineProperty(input.element,"files",{value:[file]});await input.trigger("change");await submit();
    expect(mocks.import).not.toHaveBeenCalled();expect(mocks.error).toHaveBeenCalledWith("TXT_CODE_CATALOG_UPLOAD_TOO_LARGE");
  });
  it("loads seven PCL component choices and publishes selection plus launch settings", async () => {
    mocks.officialVersions.mockResolvedValue([{id:"1.20.1",type:"release",releasedAt:"2023-06-12"}]);
    mocks.components.mockResolvedValue([{id:"0.16.10",label:"0.16.10",stable:true}]);mocks.official.mockResolvedValue({id:"created"});
    wrapper=mount(CloudImport);await flushPromises();
    wrapper.findComponent({name:"ARadioGroup"}).vm.$emit("update:value","official");await flushPromises();
    const selects=wrapper.findAllComponents({name:"ASelect"});selects[0].vm.$emit("update:value","1.20.1");await flushPromises();
    expect(wrapper.findAll(".component-card")).toHaveLength(7);expect(mocks.components).toHaveBeenCalledWith("optifabric","1.20.1");
    await submit();expect(mocks.official).toHaveBeenCalledWith("1.20.1","",undefined,expect.objectContaining({install:expect.objectContaining({minecraft:"1.20.1"}),profile:expect.objectContaining({launch:expect.any(Object)})}));
  });
  it("keeps the dialog open when publication is rejected", async () => {
    mocks.import.mockRejectedValue(new Error("forbidden")); wrapper = mount(CloudImport);
    await fileSelected(); await submit();
    expect(wrapper.emitted("done")).toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith("TXT_CODE_CATALOG_ERROR_forbidden");
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();
  });
});
