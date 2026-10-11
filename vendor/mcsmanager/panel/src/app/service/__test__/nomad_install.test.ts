import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateInstall, validateServer, resolveInstall, resolveServer, componentVersions } from "../nomad_install";
import { DEFAULT_INSTALL, DEFAULT_SERVER } from "../../../../../shared/nomad-catalog";
import { validateProfile } from "../nomad_catalog";
import { DEFAULT_PROFILE } from "../../../../../shared/nomad-catalog";
const get = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({default:{get}}));
const mc = "1.21.1";
get.mockImplementation(async (url: string) => {
  if (url.includes("version_manifest")) return {data:{versions:[{id:mc,type:"release",url:"https://piston-meta.mojang.com/version-test.json"}]}};
  if (url.endsWith("version-test.json")) return {data:{javaVersion:{majorVersion:21},downloads:{server:{url:"https://piston-data.mojang.com/server.jar",sha1:"a".repeat(40),size:100}}}};
  if (url.includes("fabricmc")) return {data:[{loader:{version:"0.16.10",stable:true}}]};
  if (url.includes("forge/minecraft")) return {data:[{version:"52.0.1"}]};
  if (url.includes("neoforged")) return {data:{versions:["21.1.80","21.0.1"]}};
  if (url.includes("optifine")) return {data:[{mcversion:mc,type:"HD_U",patch:"J1",forge:"52.0.1"}]};
  if (url.includes("api.modrinth")) return {data:[{id:"ABC123",version_number:"1",version_type:"release"}]};
  if (url.includes("papermc") && url.endsWith("/builds")) return {data:[{id:42,channel:"STABLE"}]};
  if (url.includes("papermc")) return {data:{downloads:{"server:default":{url:"https://fill-data.papermc.io/server.jar",checksums:{sha256:"b".repeat(64)},size:100}}}};
  return {data:{versions:{}}};
});
describe("cloud migration of PCL installation and runtime settings", () => {
  it("supports PCL's seven component slots", () => {
    expect(validateInstall({...DEFAULT_INSTALL,minecraft:"1.12.2",forge:"14.23.5.2859",optifine:"HD_U_G5",liteloader:"latest"})).toMatchObject({forge:"14.23.5.2859",liteloader:"latest"});
    expect(validateInstall({...DEFAULT_INSTALL,minecraft:"1.20.1",fabric:"0.16.10",fabricApi:"ABC",optifine:"HD_U_I6",optifabric:"DEF"})).toMatchObject({fabricApi:"ABC",optifabric:"DEF"});
  });
  it("enforces loader exclusivity and optional component dependencies", () => {
    for (const changes of [{forge:"1",fabric:"1"},{neoforge:"1",fabric:"1"},{fabricApi:"1"},{optifabric:"1"},{fabric:"1",optifine:"1"},{neoforge:"1",optifine:"1"},{fabric:"1",liteloader:"1"}])
      expect(() => validateInstall({...DEFAULT_INSTALL,minecraft:mc,...changes})).toThrow();
  });
  it("uses actual version sources to validate selected components", async () => {
    expect(await componentVersions("neoforge",mc)).toEqual([{id:"21.1.80",label:"21.1.80",stable:true}]);
    const result = await resolveInstall({...DEFAULT_INSTALL,minecraft:mc,fabric:"0.16.10",fabricApi:"ABC123"},{});
    expect(result.profile).toMatchObject({loader:"fabric",loaderVersion:"0.16.10",javaMajor:21});
    await expect(resolveInstall({...DEFAULT_INSTALL,minecraft:mc,fabric:"fake"},{})).rejects.toMatchObject({code:"component_version_unavailable"});
  });
  it("validates Forge/OptiFine pairings using the upstream required Forge", async () => {
    expect((await resolveInstall({...DEFAULT_INSTALL,minecraft:mc,forge:"52.0.1",optifine:"HD_U_J1"},{})).install.optifine).toBe("HD_U_J1");
  });
  it("persists detailed launch options and rejects code injection or auth overrides", () => {
    const runtime = validateProfile({...DEFAULT_PROFILE,mcVersion:mc,launch:{windowMode:"fullscreen",jvmArgs:"-XX:+UseG1GC",memoryMode:"manual",width:1920,height:1080}});
    expect(runtime.launch).toMatchObject({windowMode:"fullscreen",width:1920,memoryMode:"manual"});
    for(const jvmArgs of ["-javaagent:bad.jar","@args.txt","-jar other.jar"]) expect(() => validateProfile({...DEFAULT_PROFILE,mcVersion:mc,launch:{jvmArgs}})).toThrow();
    expect(() => validateProfile({...DEFAULT_PROFILE,mcVersion:mc,launch:{gameArgs:"--accessToken attacker"}})).toThrow();
  });
  it("requires explicit EULA and correct server runtime", async () => {
    expect(() => validateServer(DEFAULT_SERVER)).toThrow();
    const input = {...DEFAULT_SERVER,eulaAccepted:true,javaMajor:21};
    const result = await resolveServer(mc,input);
    expect(result.artifact).toMatchObject({fileName:"server.jar",sha1:"a".repeat(40),kind:"jar",launchArgs:["-jar","server.jar","nogui"]});
    await expect(resolveServer(mc,{...input,javaMajor:8})).rejects.toMatchObject({code:"java_version_too_old"});
  });
  it("resolves Forge and Paper to real installer/runtime artifact instructions", async () => {
    const base = {...DEFAULT_SERVER,eulaAccepted:true,javaMajor:21};
    const forge = await resolveServer(mc,{...base,type:"forge",version:"52.0.1"});
    expect(forge.artifact.url).toContain("1.21.1-52.0.1-installer.jar"); expect(forge.artifact.installArgs).toEqual(["-jar","installer.jar","--installServer"]);
    expect((await resolveServer(mc,{...base,type:"paper",version:"42"})).artifact.sha256).toBe("b".repeat(64));
  });
});
