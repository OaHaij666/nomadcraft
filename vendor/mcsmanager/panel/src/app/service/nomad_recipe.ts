import fs from "fs";
import * as yazl from "yazl";
import { resolveInstall, modrinthInstallFile } from "./nomad_install";
import { NomadPackages, type PackageInspection } from "./nomad_packages";
export async function publishRecipe(input: any, runtime: any, file: string, packages: NomadPackages, actorId: string) {
  const resolved = await resolveInstall(input, runtime);
  const dependencies: any = {minecraft: resolved.install.minecraft};
  if (resolved.install.forge) dependencies.forge = resolved.install.forge;
  if (resolved.install.neoforge) dependencies.neoforge = resolved.install.neoforge;
  if (resolved.install.fabric) dependencies["fabric-loader"] = resolved.install.fabric;
  const files: any[] = [];
  for (const id of [resolved.install.fabricApi, resolved.install.optifabric].filter(Boolean)) files.push(await modrinthInstallFile(id));
  const name = resolved.profile.packName || "Minecraft " + resolved.install.minecraft;
  const revision = resolved.profile.packRevision || "1";
  const index = {formatVersion: 1, game: "minecraft", name, versionId: revision, dependencies, files};
  const recipe = {...resolved.install, profile: resolved.profile, files};
  const z = new yazl.ZipFile(); z.addBuffer(Buffer.from(JSON.stringify(index)), "modrinth.index.json"); z.addBuffer(Buffer.from(JSON.stringify(recipe)), "nomad.pcl.json");
  await new Promise<void>((resolve,reject) => {const output = fs.createWriteStream(file, {flags:"wx"}); output.on("finish",resolve); output.on("error",reject); z.outputStream.on("error",reject); z.outputStream.pipe(output); z.end();});
  const inspection: PackageInspection = {format:"pcl", profile: {...resolved.profile, packName:name, packRevision:revision}, fileCount: files.length};
  const release = await packages.store(file, inspection, actorId, "official");
  release.install = resolved.install;
  return release;
}
