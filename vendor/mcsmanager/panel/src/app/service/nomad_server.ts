import {modIds} from "./nomad_mod_metadata";
import type {GatewayDeployment} from "./nomad_gateways";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { Transform, Readable } from "stream";
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
export function serverProperties(release: PublishedRelease, save?: CatalogSave, behindGateway=false) {
  const config = release.server!;
  const properties: Record<string, string | number | boolean> = {"server-port":config.port, "online-mode":behindGateway?false:config.onlineMode, motd:config.motd, "allow-flight":config.allowFlight, "enable-command-block":config.enableCommandBlock, "enable-rcon":false, "level-name":"world"};
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
export async function serverBundle(release: PublishedRelease, save?: CatalogSave, gateway?:GatewayDeployment) {
  if (!release.server || !release.serverArtifact || !release.server.eulaAccepted) throw new CatalogError(400,"server_version_unavailable");
  const directory = path.resolve("data","NomadServerArtifacts");
  const key = release.serverArtifact.url;
  let job = jobs.get(key);
  if (!job) {if(jobs.size >= 2) throw new CatalogError(429,"upload_busy"); job = downloadArtifact(release,directory).finally(() => jobs.delete(key)); jobs.set(key,job);}
  const artifactFile = await job;
  let forwarded: {file:string;metadata:{fileName:string;sourceSha1:string;sha256:string;size:number;patcherSha256:string}} | undefined;
  if(gateway?.vanillaForwarding){
    if(release.server.type!=="vanilla"||!release.serverArtifact.sha1)throw new CatalogError(409,"vanilla_forwarding_source_required");
    const nativeRequire=eval("require") as NodeRequire,assets=gateway.vanillaForwarding.assets;
    const {patchVanilla}=nativeRequire(path.join(assets,"vanilla.cjs"));
    const file=path.join(directory,"forwarded-"+uuid()+".jar");
    const result=await patchVanilla({source:artifactFile,destination:file,java:gateway.vanillaForwarding.java,patcher:path.join(assets,"dist/dependencies/vanillacord-2.0.jar"),manifest:path.join(assets,"dist/dependencies/vanillacord-2.0.jar.json"),minecraft:release.profile.mcVersion,expectedSha1:release.serverArtifact.sha1});
    forwarded={file,metadata:{fileName:"server-forwarded.jar",sourceSha1:result.sourceSha1,sha256:result.sha256,size:result.size,patcherSha256:result.patcherSha256}};
  }
  const z = new yazl.ZipFile();
  if(forwarded){const file=forwarded.file;z.outputStream.once("close",()=>{void fs.promises.unlink(file).catch(()=>undefined);});}
  try {
  const optionalIds=new Set((gateway?.files??[]).map(file=>file.unlessModId).filter(Boolean)),publishedIds=new Set<string>();
  if(optionalIds.size){for(const file of release.manifest?.files??[]){
   if(file.side==="client"||!file.path.startsWith("mods/")||!file.path.endsWith(".jar"))continue;
   const blob=path.resolve("data","NomadDistribution","blobs",file.sha256.slice(0,2),file.sha256);
   const stat=await fs.promises.stat(blob).catch(()=>null);if(stat?.size!==file.size)throw new CatalogError(409,"release_blob_missing");
   const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(blob))hash.update(chunk);
   if(hash.digest("hex")!==file.sha256)throw new CatalogError(409,"release_blob_corrupt");
   for(const id of await modIds(blob))publishedIds.add(id);
  }}
  const extra=(gateway?.files??[]).filter(file=>!file.unlessModId||!publishedIds.has(file.unlessModId)),extraHashes=new Map(extra.map(file=>[file.path,crypto.createHash("sha256").update(file.bytes).digest("hex")]));
  for(const file of release.manifest?.files??[]){if(extraHashes.has(file.path)&&extraHashes.get(file.path)!==file.sha256)throw new CatalogError(409,"gateway_release_file_conflict");}
  const extraManifest=extra.map(file=>({path:file.path,sha256:extraHashes.get(file.path)!,size:file.bytes.length,side:"server",ownership:"managed"}));

  if(release.manifest){const directory=path.resolve('data','NomadDistribution','blobs');for(const f of release.manifest.files.filter(f=>f.side!=='client'&&!extraHashes.has(f.path))){const file=path.join(directory,f.sha256.slice(0,2),f.sha256);const stat=await fs.promises.stat(file).catch(()=>null);if(stat?.size!==f.size)throw new CatalogError(409,'release_blob_missing');const h=crypto.createHash('sha256');for await(const c of fs.createReadStream(file))h.update(c);if(h.digest('hex')!==f.sha256)throw new CatalogError(409,'release_blob_corrupt');z.addFile(file,f.path);}}

  for(const file of extra)z.addBuffer(file.bytes,file.path);
  if(forwarded)z.addFile(forwarded.file,forwarded.metadata.fileName);
  z.addFile(artifactFile,release.serverArtifact.fileName);
  z.addBuffer(Buffer.from(serverProperties(release,save,!!gateway)),"server.properties");
  z.addBuffer(Buffer.from("eula=true\n"),"eula.txt");
  z.addBuffer(Buffer.from(release.server.jvmArgs + "\n"),"user_jvm_args.txt");
  z.addBuffer(Buffer.from(JSON.stringify({schema:1, releaseId:release.id, minecraft:release.profile.mcVersion, saveId:save?.id ?? null, artifact:{...release.serverArtifact,sha256:JSON.parse(await fs.promises.readFile(artifactFile+".json","utf8")).sha256}, runtime:release.server, forwardingRuntime:forwarded?.metadata, saveRules:save?.rules ?? null, authority:"nomad-center", executorGrantsAdmin:false,gateway:gateway?{id:gateway.id,address:gateway.address}:undefined,managedFiles:[...(release.manifest?.files.filter(f=>f.side!=='client'&&!extraHashes.has(f.path))??[]),...extraManifest]},null,2)),"nomad-server.json");
  // Policy files come from the authorized catalog, never from the executor's identity.
  const players = save?.players ?? [];
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "allowed").map(p => ({uuid:p.uuid,name:p.name})))),"whitelist.json");
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "allowed" && p.opLevel > 0).map(p => ({uuid:p.uuid,name:p.name,level:p.opLevel,bypassesPlayerLimit:false})))),"ops.json");
  z.addBuffer(Buffer.from(JSON.stringify(players.filter(p => p.access === "banned").map(p => ({uuid:p.uuid,name:p.name,created:new Date(0).toISOString(),source:"NomadCraft",expires:"forever",reason:"Banned by cloud policy"})))),"banned-players.json");
  z.addBuffer(Buffer.from("Server artifact and settings prepared by NomadCraft. Inspect nomad-server.json for installation and launch arguments. Forge/NeoForge require running the installer on the executor; no Minecraft process is launched on the center. This bundle contains the pinned runtime, approved server files and optional gateway forwarding files. The authorized world snapshot is restored separately by the executor.\n"),"README.txt");
  z.end();return z.outputStream;
  } catch(error) { (z.outputStream as Readable).destroy();if(forwarded)await fs.promises.unlink(forwarded.file).catch(()=>undefined);throw error; }
}
