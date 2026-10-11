import {openNomadZip} from "./nomad_zip";
import fs from "fs";
import { resolveInstall, modrinthInstallFile } from "./nomad_install";
import { uploadPolicy } from "./nomad_policy";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import { v4 as uuid } from "uuid";
import { CatalogError, validateProfile } from "./nomad_catalog";
import { DEFAULT_PROFILE, type PublishedRelease, type RuntimeProfile } from "../../../../shared/nomad-catalog";
const MAX_MANIFEST = 2 * 1024 * 1024;
const fail = (code = "invalid_package"): never => { throw new CatalogError(400, code); };
export function safePackagePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 240 || /[\\:\x00-\x1f]/.test(value) || value.startsWith("/")) return fail("unsafe_package_path");
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return fail("unsafe_package_path");
  return value;
}
export function safeClientFile(value: string) {
  safePackagePath(value);
  const top = value.split("/")[0].toLowerCase();
  if (!["mods", "config", "resourcepacks", "shaderpacks", "defaultconfigs", "kubejs", "scripts", "datapacks", "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat", "icon.png", "pack.png"].includes(top)) return fail("unsafe_package_path");
  return value;
}
function str(v: unknown, max = 120): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f]/.test(v)) return fail();
  return v.trim();
}
function version(v: unknown): string { const s = str(v, 40); if (!/^[a-z0-9._+-]+$/i.test(s)) return fail(); return s; }
function javaFor(mc: string) { const minor = Number(mc.split(".")[1]); return Number(mc.split(".")[0]) >= 26 ? 25 : minor >= 21 || /^1\.20\.[5-9]/.test(mc) ? 21 : minor >= 18 ? 17 : minor >= 17 ? 16 : 8; }
export interface PackageInspection { format: "modrinth" | "curseforge" | "pcl"; profile: RuntimeProfile; fileCount: number; }
export async function inspectPackage(file: string, policy = uploadPolicy()): Promise<PackageInspection> {
  const MAX_PACKAGE = policy.maxBytes, MAX_EXPANDED = policy.maxExpandedBytes;
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PACKAGE) return fail("package_too_large");
  const manifest = await new Promise<{name: string; body: Buffer; entries: number}>((resolve, reject) => {
    openNomadZip(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new CatalogError(400, "invalid_package")); return; }
      let expanded = 0, count = 0, body: Buffer | null = null, name = "";
      const seen = new Set<string>(); let done = false;
      const abort = (e: unknown) => { if (!done) { done = true; zip.close(); reject(e); } };
      zip.on("error", () => abort(new CatalogError(400, "invalid_package")));
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          safePackagePath(entry.fileName);
          if (["mcbbs.packmeta", "mmc-pack.json", "modpack.json", "modpack.zip", "modpack.mrpack"].includes(entry.fileName.toLowerCase())) fail("unsupported_package");
          if (/^(overrides|client-overrides|server-overrides)\//i.test(entry.fileName) && !entry.fileName.endsWith("/")) safeClientFile(entry.fileName.substring(entry.fileName.indexOf("/") + 1));
          const key = entry.fileName.toLowerCase();
          const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (seen.has(key) || (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) || (entry.generalPurposeBitFlag & 1)) fail();
          seen.add(key); count++; expanded += entry.uncompressedSize;
          if (count > 20000 || expanded > MAX_EXPANDED || entry.uncompressedSize > MAX_PACKAGE) fail("package_too_large");
          if (!["modrinth.index.json", "manifest.json"].includes(entry.fileName)) { zip.readEntry(); return; }
          if (body || entry.uncompressedSize > MAX_MANIFEST) fail();
          name = entry.fileName;
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) { abort(new CatalogError(400, "invalid_package")); return; }
            const chunks: Buffer[] = []; let bytes = 0;
            stream.on("data", (c: Buffer) => { bytes += c.length; if (bytes > MAX_MANIFEST) { stream.destroy(); abort(new CatalogError(400, "package_too_large")); } else chunks.push(c); });
            stream.on("error", () => abort(new CatalogError(400, "invalid_package")));
            stream.on("end", () => { body = Buffer.concat(chunks); zip.readEntry(); });
          });
        } catch (e) { abort(e); }
      });
      zip.on("end", () => { if (!done) { done = true; body ? resolve({name, body, entries: count}) : reject(new CatalogError(400, "unsupported_package")); } });
      zip.readEntry();
    });
  });
  let m: any; try { m = JSON.parse(manifest.body.toString("utf8")); } catch { return fail(); }
  let mc: string, loader: RuntimeProfile["loader"] = "vanilla", loaderVersion = "", fileCount = 0;
  const format = manifest.name === "modrinth.index.json" ? "modrinth" : "curseforge";
  if (format === "modrinth") {
    if (m.game !== "minecraft" || m.formatVersion !== 1 || !Array.isArray(m.files) || m.files.length > 10000 || !m.dependencies) return fail();
    mc = version(m.dependencies.minecraft);
    const keys = Object.keys(m.dependencies).filter(k => k !== "minecraft");
    if (keys.length > 1 || keys.some(k => !["forge", "neoforge", "fabric-loader"].includes(k))) return fail("unsupported_loader");
    if (keys.length) { loader = keys[0] === "fabric-loader" ? "fabric" : keys[0] as any; loaderVersion = version(m.dependencies[keys[0]]); }
    const paths = new Set<string>();
    for (const f of m.files) {
      const p = safeClientFile(f.path).toLowerCase();
      if (p.endsWith("/") || paths.has(p) || !f.hashes || !/^[a-f0-9]{40}$/i.test(f.hashes.sha1 ?? "") || !/^[a-f0-9]{128}$/i.test(f.hashes.sha512 ?? "")) return fail();
      paths.add(p);
      if (!Number.isSafeInteger(f.fileSize) || f.fileSize < 0 || f.fileSize > MAX_PACKAGE || !Array.isArray(f.downloads) || !f.downloads.length || f.downloads.length > 5) return fail();
      for (const d of f.downloads) {
        let u: URL; try { u = new URL(d); } catch { return fail(); }
        if (u.protocol !== "https:" || u.username || u.password || u.port || !["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com", "edge.forgecdn.net", "mediafilez.forgecdn.net"].includes(u.hostname)) return fail("unsafe_download_url");
      }
      if (f.env && [f.env.client, f.env.server].some(v => !["required", "optional", "unsupported"].includes(v))) return fail();
    }
    fileCount = m.files.length + manifest.entries - 1;
  } else {
    if (m.manifestType !== "minecraftModpack" || m.manifestVersion !== 1 || !Array.isArray(m.files) || m.files.length > 10000) return fail();
    mc = version(m.minecraft?.version);
    if (!Array.isArray(m.minecraft?.modLoaders) || m.minecraft.modLoaders.length > 1) return fail("unsupported_loader");
    if (m.minecraft.modLoaders.length) {
      const id = str(m.minecraft.modLoaders[0].id, 80), match = /^(forge|neoforge|fabric)-(.+)$/.exec(id);
      if (!match) return fail("unsupported_loader"); loader = match[1] as any; loaderVersion = version(match[2]);
    }
    safePackagePath(m.overrides);
    if (m.overrides !== "overrides") return fail("unsupported_package");
    for (const f of m.files) if (!Number.isSafeInteger(f.projectID) || f.projectID < 1 || !Number.isSafeInteger(f.fileID) || f.fileID < 1 || typeof f.required !== "boolean") return fail();
    fileCount = m.files.length + manifest.entries - 1;
  }
  const name = str(m.name), revision = str(format === "modrinth" ? m.versionId : m.version, 80);
  return { format, fileCount, profile: validateProfile({...DEFAULT_PROFILE, mcVersion: mc, loader, loaderVersion, packName: name, packRevision: revision, javaMajor: javaFor(mc)}) };
}
export class NomadPackages {
  constructor(private directory = path.resolve("data", "NomadPackages")) {}
  path(sha256: string) { if (!/^[a-f0-9]{64}$/.test(sha256)) return fail("invalid_hash"); return path.join(this.directory, sha256); }
  async store(file: string, inspection: PackageInspection, actorId: string, source: PublishedRelease["source"] = "upload", maxBytes = uploadPolicy().maxBytes): Promise<PublishedRelease> {
    const hash = crypto.createHash("sha256"); let size = 0;
    for await (const chunk of fs.createReadStream(file)) { size += chunk.length; if (size > maxBytes) return fail("package_too_large"); hash.update(chunk); }
    const sha256 = hash.digest("hex");
    await fs.promises.mkdir(this.directory, {recursive: true});
    const staging = path.join(this.directory, uuid() + ".part");
    try {
      await fs.promises.copyFile(file, staging, fs.constants.COPYFILE_EXCL);
      // An atomic rename publishes only a complete immutable archive.
      if (!(await fs.promises.stat(this.path(sha256)).catch(() => null))) await fs.promises.rename(staging, this.path(sha256));
    } finally { await fs.promises.unlink(staging).catch(() => undefined); }
    const id = uuid(); const fileName = "nomad-" + id + (inspection.format === "modrinth" ? ".mrpack" : ".zip");
    return {id, format: inspection.format, source, fileName, sha256, size, profile: {...inspection.profile, artifact: fileName, artifactSha256: sha256}, publishedAt: Date.now(), publishedBy: actorId, fileCount: inspection.fileCount};
  }
}
let manifestCache: {at: number; versions: any[]} | undefined;
export async function officialVersions() {
  if (!manifestCache || Date.now() - manifestCache.at > 300000) {
    const response = await axios.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", {timeout: 20000, maxContentLength: MAX_MANIFEST, maxRedirects: 0});
    if (!Array.isArray(response.data?.versions)) throw new CatalogError(502, "official_unavailable");
    manifestCache = {at: Date.now(), versions: response.data.versions.filter((v: any) => v.type === "release" && typeof v.id === "string" && /^[a-z0-9._+-]+$/i.test(v.id))};
  }
  return manifestCache.versions.map(v => ({id: v.id, releasedAt: v.releaseTime}));
}
export async function makeOfficialPackage(versionId: unknown, file: string) {
  const mc = version(versionId);
  if (!(await (await import("./nomad_install")).minecraftVersions()).some((v: any) => v.id === mc)) return fail("invalid_official_version");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({formatVersion: 1, game: "minecraft", name: "Minecraft " + mc, versionId: mc, files: [], dependencies: {minecraft: mc}})), "modrinth.index.json");
  await new Promise<void>((resolve, reject) => { const out = fs.createWriteStream(file, {flags: "wx"}); out.on("error", reject); zip.outputStream.on("error", reject); out.on("finish", resolve); zip.outputStream.pipe(out); zip.end(); });
  return inspectPackage(file);
}
