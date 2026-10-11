import axios from "axios";
import { CatalogError, validateProfile } from "./nomad_catalog";
import { DEFAULT_INSTALL, DEFAULT_PROFILE, DEFAULT_SERVER, type InstallChoice, type InstallSelection, type RuntimeProfile, type ServerArtifact, type ServerSettings } from "../../../../shared/nomad-catalog";
const fail = (code = "invalid_install_selection"): never => {throw new CatalogError(400, code);};
const clean = (v: unknown) => { if (typeof v !== "string" || v.length > 120 || !/^[a-z0-9._+ -]*$/i.test(v)) return fail(); return v; };
const cache = new Map<string, {at: number; data: any}>();
export async function sourceJson(url: string) {
  const hit = cache.get(url); if (hit && Date.now() - hit.at < 300000) return hit.data;
  try {
    const r = await axios.get(url, {timeout: 20000, maxContentLength: 10 * 1024 * 1024, maxRedirects: 0, headers: {"User-Agent": "NomadCraft/0.1 (cloud Minecraft instance manager)", Accept: "application/json"}});
    let data = r.data; if (typeof data === "string" && /^[\[{]/.test(data)) data = JSON.parse(data);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(url, {at: Date.now(), data}); return data;
  } catch { throw new CatalogError(502, "component_source_unavailable"); }
}
export async function minecraftVersions() {
  const data = await sourceJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  if (!Array.isArray(data.versions)) throw new CatalogError(502, "official_unavailable");
  return data.versions.filter((v: any) => ["release", "snapshot", "old_alpha", "old_beta"].includes(v.type) && typeof v.id === "string" && /^[a-z0-9._+-]+$/i.test(v.id)).map((v: any) => ({id: v.id, type: v.type, releasedAt: v.releaseTime}));
}
export async function minecraftMetadata(mc: string) {
  const manifest = await sourceJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const selected = manifest.versions?.find((v: any) => v.id === mc); if (!selected) return fail("invalid_official_version");
  const url = new URL(selected.url); if (url.protocol !== "https:" || url.hostname !== "piston-meta.mojang.com") return fail();
  return sourceJson(url.toString());
}
export type InstallComponent = "forge" | "neoforge" | "fabric" | "fabricApi" | "optifine" | "optifabric" | "liteloader" | "paper";
export async function componentVersions(component: string, minecraft: unknown): Promise<InstallChoice[]> {
  const mc = clean(minecraft); if (!mc) return fail();
  if (component === "fabric") {
    const data = await sourceJson("https://meta.fabricmc.net/v2/versions/loader/" + encodeURIComponent(mc));
    return data.map((v: any) => ({id: v.loader.version, label: v.loader.version, stable: Boolean(v.loader.stable)}));
  }
  if (component === "forge") {
    // Same catalog provider and mapping used by PCL's DlForgeVersionMain.
    const data = await sourceJson("https://bmclapi2.bangbang93.com/forge/minecraft/" + encodeURIComponent(mc));
    return data.filter((v: any) => typeof v.version === "string").map((v: any) => ({id: v.version, label: v.version + (v.branch ? " (" + v.branch + ")" : ""), stable: !v.version.includes("beta")})).reverse();
  }
  if (component === "neoforge") {
    const legacy = mc === "1.20.1"; const data = await sourceJson("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/" + (legacy ? "forge" : "neoforge"));
    const prefix = (Number(mc.split(".")[0]) >= 26 ? mc : mc.split(".").slice(1).join(".")) + ".";
    return (data.versions ?? []).filter((v: string) => legacy ? v.startsWith("47.") : v.startsWith(prefix)).map((v: string) => ({id: v, label: v, stable: !v.includes("beta")})).reverse();
  }
  if (component === "fabricApi" || component === "optifabric") {
    const project = component === "fabricApi" ? "fabric-api" : "optifabric";
    const data = await sourceJson("https://api.modrinth.com/v2/project/" + project + "/version?loaders=" + encodeURIComponent('["fabric"]') + "&game_versions=" + encodeURIComponent(JSON.stringify([mc])));
    return data.map((v: any) => ({id: v.id, label: v.version_number, stable: v.version_type === "release"}));
  }
  if (component === "optifine") {
    const data = await sourceJson("https://bmclapi2.bangbang93.com/optifine/versionList");
    return data.filter((v: any) => v.mcversion === mc).map((v: any) => ({id: v.type + "_" + v.patch, label: v.type + "_" + v.patch, stable: !String(v.patch).includes("pre"), requiredForge: v.forge === undefined || v.forge === null || /N\/A/i.test(String(v.forge)) ? null : String(v.forge)})).reverse();
  }
  if (component === "liteloader") {
    const data = await sourceJson("https://bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json");
    const row = data.versions?.[mc]; const latest = (row?.artefacts ?? row?.snapshots)?.["com.mumfrey:liteloader"]?.latest;
    return latest ? [{id: String(latest.version ?? "latest"), label: String(latest.version ?? "latest"), stable: latest.stream !== "snapshot"}] : [];
  }
  if (component === "paper") {
    const data = await sourceJson("https://fill.papermc.io/v3/projects/paper/versions/" + encodeURIComponent(mc) + "/builds");
    const rows = Array.isArray(data) ? data : data.builds ?? [];
    return rows.map((v: any) => ({id: String(v.id), label: String(v.id) + " · " + String(v.channel ?? ""), stable: v.channel === "STABLE"})).sort((a: InstallChoice,b: InstallChoice) => Number(b.id)-Number(a.id));
  }
  return fail("unsupported_loader");
}
export function validateInstall(input: any): InstallSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const result = {...DEFAULT_INSTALL};
  for (const key of Object.keys(result) as Array<keyof InstallSelection>) result[key] = clean(input[key] ?? "");
  if (!result.minecraft || [result.forge, result.neoforge, result.fabric].filter(Boolean).length > 1) return fail("incompatible_components");
  if ((result.fabricApi || result.optifabric) && !result.fabric) return fail("incompatible_components");
  if (result.optifabric && !result.optifine) return fail("incompatible_components");
  if (result.optifine && result.fabric && !result.optifabric) return fail("optifabric_required");
  if ((result.optifine && result.neoforge) || (result.liteloader && (result.fabric || result.neoforge))) return fail("incompatible_components");
  if (result.optifine && result.fabric && compareMc(result.minecraft, "1.20.4") > 0) return fail("incompatible_components");
  if (result.optifine && result.forge && compareMc(result.minecraft, "1.13") >= 0 && compareMc(result.minecraft, "1.14.3") <= 0) return fail("incompatible_components");
  return result;
}
function compareMc(a: string, b: string) {const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0;}
export async function resolveInstall(input: any, runtime: any) {
  const install = validateInstall(input);
  const meta = await minecraftMetadata(install.minecraft);
  const choices: Record<string, InstallChoice> = {};
  for (const key of Object.keys(install).filter(k => k !== "minecraft" && install[k as keyof InstallSelection])) {
    const found = (await componentVersions(key, install.minecraft)).find(v => v.id === install[key as keyof InstallSelection]);
    if (!found) return fail("component_version_unavailable"); choices[key] = found;
  }
  if (install.optifine && install.forge) {
    const req = choices.optifine.requiredForge;
    if (req === null || req === undefined || (req.trim() && (req.includes(".") ? req !== install.forge : req !== install.forge.split(".").slice(-1)[0]))) return fail("incompatible_components");
  }
  const profile = validateProfile({...DEFAULT_PROFILE, ...runtime, mcVersion: install.minecraft, loader: install.forge ? "forge" : install.neoforge ? "neoforge" : install.fabric ? "fabric" : "vanilla", loaderVersion: install.forge || install.neoforge || install.fabric, javaMajor: runtime?.javaMajor > 0 ? runtime.javaMajor : meta.javaVersion?.majorVersion ?? 8});
  return {install, profile};
}
export async function modrinthInstallFile(versionId: string) {
  const v = await sourceJson("https://api.modrinth.com/v2/version/" + encodeURIComponent(versionId));
  const file = v.files?.find((f: any) => f.primary) ?? v.files?.[0];
  if (!file || new URL(file.url).hostname !== "cdn.modrinth.com" || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 ?? "")) return fail();
  return {path: "mods/" + file.filename, hashes: file.hashes, downloads: [file.url], fileSize: file.size};
}
export function validateServer(input: any): ServerSettings {
  const p = {...DEFAULT_SERVER, ...input};
  if (!["vanilla", "paper", "fabric", "forge", "neoforge"].includes(p.type) || typeof p.eulaAccepted !== "boolean" || !p.eulaAccepted) return fail("eula_required");
  if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535 || !Number.isInteger(p.memoryMb) || p.memoryMb < 512 || p.memoryMb > 262144 || !Number.isInteger(p.javaMajor) || p.javaMajor < 8 || p.javaMajor > 99) return fail();
  if (typeof p.motd !== "string" || p.motd.length > 120 || /[\r\n\x00]/.test(p.motd) || [p.onlineMode,p.allowFlight,p.enableCommandBlock].some(v => typeof v !== "boolean")) return fail();
  const profile = validateProfile({...DEFAULT_PROFILE, mcVersion: "server", javaMajor: p.javaMajor, memoryMb: p.memoryMb, launch: {jvmArgs: p.jvmArgs}});
  return {...p, version: clean(p.version), jvmArgs: profile.launch!.jvmArgs};
}
export async function resolveServer(mc: string, input: any): Promise<{settings: ServerSettings; artifact: ServerArtifact}> {
  const settings = validateServer(input);
  const meta = await minecraftMetadata(mc);
  const major = meta.javaVersion?.majorVersion ?? 8;
  if (settings.javaMajor < major) return fail("java_version_too_old");
  if (settings.type === "vanilla") {
    if (!meta.downloads?.server) return fail("server_version_unavailable");
    const server = meta.downloads.server;
    return {settings, artifact: {url: server.url, fileName: "server.jar", sha1: server.sha1, size: server.size, kind: "jar", installArgs: [], launchArgs: ["-jar", "server.jar", "nogui"]}};
  }
  const list = await componentVersions(settings.type, mc);
  if (!list.some(v => v.id === settings.version)) return fail("component_version_unavailable");
  if (settings.type === "paper") {
    const row = await sourceJson("https://fill.papermc.io/v3/projects/paper/versions/" + encodeURIComponent(mc) + "/builds/" + settings.version);
    const download = row.downloads?.["server:default"]; if (!download?.url || !download?.checksums?.sha256) return fail("server_version_unavailable");
    return {settings, artifact: {url: download.url, fileName: "server.jar", sha256: download.checksums.sha256, size: download.size, kind: "jar", installArgs: [], launchArgs: ["-jar", "server.jar", "nogui"]}};
  }
  if (settings.type === "fabric") {
    const installers = await sourceJson("https://meta.fabricmc.net/v2/versions/installer"); const installer = installers.find((v: any) => v.stable) ?? installers[0];
    return {settings, artifact: {url: "https://meta.fabricmc.net/v2/versions/loader/" + encodeURIComponent(mc) + "/" + settings.version + "/" + installer.version + "/server/jar", fileName: "server.jar", kind: "jar", installArgs: [], launchArgs: ["-jar", "server.jar", "nogui"]}};
  }
  const forge = settings.type === "forge";
  const base = forge ? "https://maven.minecraftforge.net/net/minecraftforge/forge/" : "https://maven.neoforged.net/releases/net/neoforged/" + (mc === "1.20.1" ? "forge/" : "neoforge/");
  const v = forge ? mc + "-" + settings.version : settings.version;
  const id = forge || mc === "1.20.1" ? "forge" : "neoforge";
  return {settings, artifact: {url: base + v + "/" + id + "-" + v + "-installer.jar", fileName: "installer.jar", kind: "installer", installArgs: ["-jar", "installer.jar", "--installServer"], launchArgs: compareMc(mc,"1.17") >= 0 ? ["@user_jvm_args.txt", "@libraries/" + (forge ? "net/minecraftforge/forge/" : "net/neoforged/" + id + "/") + v + "/win_args.txt", "nogui"] : ["-jar", "forge-" + v + ".jar", "nogui"]}};
}
