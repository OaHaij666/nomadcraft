import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { Transform } from "stream";
import { promisify } from "util";
import { pipeline } from "stream";
import * as yazl from "yazl";
import { v4 as uuid } from "uuid";
import { CatalogError } from "./nomad_catalog";
import { uploadPolicy } from "./nomad_policy";
import type { PublishedRelease, CatalogSave } from "../../../../shared/nomad-catalog";
const pipe = promisify(pipeline);
const jobs = new Map<string, Promise<string>>();
function safeUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !["piston-data.mojang.com", "launcher.mojang.com", "launchermeta.mojang.com", "meta.fabricmc.net", "maven.minecraftforge.net", "maven.neoforged.net", "fill-data.papermc.io"].includes(u.hostname)) throw new CatalogError(400, "unsafe_download_url");
  return u.toString();
}
export function serverProperties(release: PublishedRelease, save?: CatalogSave) {
  const config = release.server!;
  const properties: Record<string, string | number | boolean> = {"server-port":config.port, "online-mode":config.onlineMode, motd:config.motd, "allow-flight":config.allowFlight, "enable-command-block":config.enableCommandBlock, "enable-rcon":false, "level-name":"world"};
  if (save) Object.assign(properties, {"level-seed":save.rules.seed, gamemode:save.rules.gameMode, difficulty:save.rules.difficulty, "max-players":save.rules.maxPlayers, "view-distance":save.rules.viewDistance, "simulation-distance":save.rules.simulationDistance, pvp:save.rules.pvp, hardcore:save.rules.hardcore, "white-list":save.rules.whitelist});
  const escape = (value: unknown) => String(value).replace(/\\/g,"\\\\").replace(/[\r\n]/g,"").replace(/=/g,"\\=");
  return Object.keys(properties).map(k => k + "=" + escape(properties[k])).join("\n") + "\n";
}
async function downloadArtifact(release: PublishedRelease, directory: string) {
  const artifact = release.serverArtifact!;
  const url = safeUrl(artifact.url), max = uploadPolicy().maxBytes;
  await fs.promises.mkdir(directory,{recursive:true});
  const file = path.join(directory, crypto.createHash("sha256").update(url).digest("hex"));
  const recordFile = file + ".json";
  const existing = await fs.promises.stat(file).catch(() => null);
  if (existing) {
    const record = JSON.parse(await fs.promises.readFile(recordFile,"utf8").catch(() => "null"));
    if (record && record.size === existing.size) {
      const sha256 = crypto.createHash("sha256"), sha1 = crypto.createHash("sha1");
      for await (const chunk of fs.createReadStream(file)) {sha256.update(chunk); sha1.update(chunk);}
      if (sha256.digest("hex") === record.sha256 && (!artifact.sha1 || sha1.digest("hex") === artifact.sha1) && (!artifact.sha256 || record.sha256 === artifact.sha256)) return file;
    }
  }
  const staging = file + "." + uuid() + ".part";
  try {
    const response = await axios.get(url, {responseType:"stream", timeout:120000, maxRedirects:0, headers:{"User-Agent":"NomadCraft/0.1 (Minecraft cloud instance manager)"}});
    const sha256 = crypto.createHash("sha256"), sha1 = crypto.createHash("sha1"); let size = 0;
    const guard = new Transform({transform(chunk, _encoding, cb) {size += chunk.length; if (size > max) {cb(new CatalogError(413,"package_too_large"));return;} sha256.update(chunk); sha1.update(chunk); cb(null,chunk);}});
    await pipe(response.data,guard,fs.createWriteStream(staging,{flags:"wx"}));
    const hash256 = sha256.digest("hex"), hash1 = sha1.digest("hex");
    if ((artifact.size && artifact.size !== size) || (artifact.sha1 && artifact.sha1 !== hash1) || (artifact.sha256 && artifact.sha256 !== hash256)) throw new CatalogError(502,"server_checksum_failed");
    await fs.promises.rename(staging,file);
    await fs.promises.writeFile(recordFile,JSON.stringify({sha256:hash256,size}));
    return file;
  } finally {await fs.promises.unlink(staging).catch(() => undefined);}
}
export async function serverBundle(release: PublishedRelease, save?: CatalogSave) {
  if (!release.server || !release.serverArtifact || !release.server.eulaAccepted) throw new CatalogError(400,"server_version_unavailable");
  const directory = path.resolve("data","NomadServerArtifacts");
  const key = release.serverArtifact.url;
  let job = jobs.get(key);
  if (!job) {if(jobs.size >= 2) throw new CatalogError(429,"upload_busy"); job = downloadArtifact(release,directory).finally(() => jobs.delete(key)); jobs.set(key,job);}
  const artifactFile = await job;
  const z = new yazl.ZipFile();
  z.addFile(artifactFile,release.serverArtifact.fileName);
  z.addBuffer(Buffer.from(serverProperties(release,save)),"server.properties");
  z.addBuffer(Buffer.from("eula=true\n"),"eula.txt");
  z.addBuffer(Buffer.from(release.server.jvmArgs + "\n"),"user_jvm_args.txt");
  z.addBuffer(Buffer.from(JSON.stringify({schema:1, releaseId:release.id, minecraft:release.profile.mcVersion, saveId:save?.id ?? null, artifact:release.serverArtifact, runtime:release.server, saveRules:save?.rules ?? null, authority:"nomad-center", executorGrantsAdmin:false},null,2)),"nomad-server.json");
  // Policy files come from the authorized catalog, never from the executor's identity.
  const players = save?.players ?? [];
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "allowed").map(p => ({uuid:p.uuid,name:p.name})))),"whitelist.json");
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "allowed" && p.opLevel > 0).map(p => ({uuid:p.uuid,name:p.name,level:p.opLevel,bypassesPlayerLimit:false})))),"ops.json");
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "banned").map(p => ({uuid:p.uuid,name:p.name,created:new Date(0).toISOString(),source:"NomadCraft",expires:"forever",reason:"Banned by cloud policy"})))),"banned-players.json");
  z.addBuffer(Buffer.from("Server artifact and settings prepared by NomadCraft. Inspect nomad-server.json for installation and launch arguments. Forge/NeoForge require running the installer on the executor; no Minecraft process is launched on the center. This bundle contains no world snapshot or modpack server-side files. It is a server-runtime foundation; attach the authorized save snapshot and approved server mod manifest before opening a room.\n"),"README.txt");
  z.end();return z.outputStream;
}
