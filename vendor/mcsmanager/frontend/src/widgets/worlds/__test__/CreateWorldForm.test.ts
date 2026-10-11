// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateWorldForm from "../CreateWorldForm.vue";
import { WORLD_SOURCE } from "@/types/world";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  address: vi.fn(),
  append: vi.fn(),
  error: vi.fn()
}));
const uploadConfig = ref({
  instanceUuid: "new-world",
  password: "test-upload",
  address: "localhost",
  port: 24444
});
vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/hooks/useInstance", () => ({
  TYPE_MINECRAFT_JAVA: "minecraft/java",
  INSTANCE_TYPE_TRANSLATION: {
    "minecraft/java": "Java",
    "minecraft/java/fabric": "Fabric",
    "steam/universal": "Steam"
  }
}));
vi.mock("@/types/const", () => ({
  defaultInstanceInfo: {
    nickname: "",
    cwd: "",
    startCommand: "",
    stopCommand: "",
    type: "universal",
    docker: { image: "" },
    java: { maxMemory: 0 },
    tag: []
  }
}));
vi.mock("@/hooks/useFileManager", () => ({ getFileConfigAddr: () => "http://localhost:24444" }));
vi.mock("@/services/apis/instance", () => ({
  createInstance: () => ({
    execute: mocks.create,
    state: ref({ instanceUuid: "new-world" }),
    isLoading: ref(false)
  }),
  uploadAddress: () => ({ execute: mocks.address, state: uploadConfig })
}));
vi.mock("@/services/uploadService", () => ({
  default: { uiData: ref({ current: undefined }), append: mocks.append, getFileNth: () => 1 }
}));
vi.mock("@/tools/validator", () => ({ reportErrorMsg: mocks.error }));
vi.mock("@/widgets/instance/dialogs/SelectUnzipCode.vue", () => ({
  default: { template: "<div />", setup: () => ({ openDialog: vi.fn() }) }
}));
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.create.mockResolvedValue({ value: { instanceUuid: "new-world" } });
  mocks.address.mockResolvedValue({ value: uploadConfig.value });
  mocks.append.mockImplementation(() => ({
    addCallback: vi.fn(),
    removeCallback: vi.fn(),
    id: "upload"
  }));
});
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers.length = 0;
  vi.restoreAllMocks();
});
const render = (source: WORLD_SOURCE) => {
  const wrapper = mount(CreateWorldForm, { props: { createMethod: source, daemonId: "host-a" } });
  wrappers.push(wrapper);
  return wrapper;
};
describe("Minecraft world creation", () => {
  it("keeps new-world forms independent", async () => {
    const first = render(WORLD_SOURCE.FILE);
    await first.find("input").setValue("First save");
    const second = render(WORLD_SOURCE.FILE);
    expect((second.find("input").element as HTMLInputElement).value).toBe("");
  });
  it("creates an existing-directory world with Minecraft defaults and selected host", async () => {
    const wrapper = render(WORLD_SOURCE.EXIST);
    await wrapper
      .findAll(".ant-form-item")
      .find((item) => item.text().includes("TXT_CODE_WORLD_NAME"))!
      .find("input")
      .setValue("Existing save");
    await wrapper
      .findAll(".ant-form-item")
      .find((item) => item.text().includes("TXT_CODE_WORLD_DIRECTORY"))!
      .find("input")
      .setValue("C:/servers/world");
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("TXT_CODE_WORLD_CREATE"))!
      .trigger("click");
    await flushPromises();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      params: { daemonId: "host-a" },
      data: {
        nickname: "Existing save",
        cwd: "C:/servers/world",
        type: "minecraft/java",
        stopCommand: "stop"
      }
    });
    expect(wrapper.emitted("nextStep")).toEqual([["new-world"]]);
  });
  it("rejects the wrong file format before creating an instance", async () => {
    const wrapper = render(WORLD_SOURCE.FILE);
    await (wrapper.findComponent({ name: "AUpload" }).props("beforeUpload") as any)(
      new File(["x"], "world.zip")
    );
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.address).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
