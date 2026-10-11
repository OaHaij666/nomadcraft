import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import * as yazl from "yazl";
import { inspectPackage, NomadPackages, safePackagePath, safeClientFile } from "../nomad_packages";
let dir = "";
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "nomad-pack-test-")); });
afterEach(async () => { if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith("nomad-pack-test-")) await fs.rm(dir, {recursive: true, force: true}); });
const mr = () => ({formatVersion: 1, game: "minecraft", name: "Friends", versionId: "v1", files: [], dependencies: {minecraft: "1.20.1", "fabric-loader": "0.16.10"}});
export async function archive(file: string, manifest: any, name = "modrinth.index.json", other?: string) {
  const z = new yazl.ZipFile(); z.addBuffer(Buffer.from(JSON.stringify(manifest)), name);
  if (other) z.addBuffer(Buffer.from("x"), other);
  const stream = (await import("fs")).createWriteStream(file);
  await new Promise<void>((resolve, reject) => {stream.on("finish", resolve); stream.on("error", reject); z.outputStream.pipe(stream); z.end();});
}
describe("immutable cloud package validation", () => {
  it("derives runtime data from Modrinth and stores a content-addressed archive", async () => {
    const file = path.join(dir, "a.mrpack"); await archive(file, mr(), undefined, "overrides/config/hello.txt");
    const p = await inspectPackage(file); expect(p.profile).toMatchObject({mcVersion: "1.20.1", loader: "fabric", loaderVersion: "0.16.10", javaMajor: 17});
    const store = new NomadPackages(path.join(dir, "blobs")); const r = await store.store(file, p, "publisher");
    const bytes = await fs.readFile(store.path(r.sha256)); expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(r.sha256);
    expect(r.profile.artifactSha256).toBe(r.sha256);
    const second = await store.store(file, p, "publisher"); expect(second.id).not.toBe(r.id); expect(second.sha256).toBe(r.sha256);
    expect(await fs.readdir(path.join(dir, "blobs"))).toEqual([r.sha256]);
  });
  it("accepts archives larger than the former 500 MB ceiling without buffering them", async () => {
    const file = path.join(dir,"large.zip"), length = 600*1024*1024;
    const index = Buffer.from(JSON.stringify(mr())), names = [Buffer.from("modrinth.index.json"),Buffer.from("overrides/config/large.dat")];
    const crc = (bytes:Buffer) => {let value=0xffffffff;for(const b of bytes){value^=b;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
    const sizes=[index.length,length], checksums=[crc(index),0], offsets:number[]=[];
    const handle=await fs.open(file,"w");let offset=0;
    try {
      for(let i=0;i<2;i++) {
        offsets.push(offset);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt32LE(checksums[i],14);header.writeUInt32LE(sizes[i],18);header.writeUInt32LE(sizes[i],22);header.writeUInt16LE(names[i].length,26);
        await handle.write(Buffer.concat([header,names[i]]),0,30+names[i].length,offset);offset+=30+names[i].length;
        if(i===0)await handle.write(index,0,index.length,offset);
        offset+=sizes[i];
      }
      const directoryOffset=offset;
      for(let i=0;i<2;i++){const h=Buffer.alloc(46);h.writeUInt32LE(0x02014b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(20,6);h.writeUInt32LE(checksums[i],16);h.writeUInt32LE(sizes[i],20);h.writeUInt32LE(sizes[i],24);h.writeUInt16LE(names[i].length,28);h.writeUInt32LE(offsets[i],42);const row=Buffer.concat([h,names[i]]);await handle.write(row,0,row.length,offset);offset+=row.length;}
      const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(offset-directoryOffset,12);end.writeUInt32LE(directoryOffset,16);await handle.write(end,0,end.length,offset);
    } finally {await handle.close();}
    expect((await fs.stat(file)).size).toBeGreaterThan(500*1024*1024);
    expect((await inspectPackage(file)).profile.mcVersion).toBe("1.20.1");
    await expect(inspectPackage(file,{maxGiB:0.5,maxBytes:500*1024*1024,maxExpandedBytes:2*1024**3})).rejects.toMatchObject({code:"package_too_large"});
  },30000);
  it("derives a CurseForge runtime and validates project identifiers", async () => {
    const file = path.join(dir, "a.zip");
    const cf = {name: "CF", version: "1", manifestType: "minecraftModpack", manifestVersion: 1, minecraft: {version: "1.20.1", modLoaders: [{id: "forge-47.4.0", primary: true}]}, files: [{projectID: 123, fileID: 456, required: true}], overrides: "overrides"};
    await archive(file, cf, "manifest.json"); expect((await inspectPackage(file)).profile.loader).toBe("forge");
    cf.files[0].fileID = -1; await archive(file, cf, "manifest.json"); await expect(inspectPackage(file)).rejects.toMatchObject({code: "invalid_package"});
  });
  it("rejects zip traversal, Windows special paths and launcher config injection", () => {
    for (const p of ["../x", "/x", "C:/x", "mods\\x", "mods/../x", "mods/CON.jar", "mods/a.", "mods//x", "mods/x:stream"]) expect(() => safePackagePath(p)).toThrow();
    expect(() => safeClientFile("PCL/config.json")).toThrow(); expect(() => safeClientFile("versions/x/x.json")).toThrow();
    expect(safeClientFile("mods/a.jar")).toBe("mods/a.jar");
  });
  it("rejects alternate format markers that change the launcher's parser", async () => {
    const file = path.join(dir, "a.zip"); await archive(file, mr(), undefined, "mcbbs.packmeta"); await expect(inspectPackage(file)).rejects.toMatchObject({code: "unsupported_package"});
  });
  it("rejects duplicate manifests and unsafe embedded overrides", async () => {
    const file = path.join(dir, "a.zip"); await archive(file, mr(), undefined, "manifest.json"); await expect(inspectPackage(file)).rejects.toMatchObject({code: "invalid_package"});
    await archive(file, mr(), undefined, "overrides/PCL/config.json"); await expect(inspectPackage(file)).rejects.toMatchObject({code: "unsafe_package_path"});
  });
  it("rejects malformed files, unsupported loaders and embedded local URLs", async () => {
    const file = path.join(dir, "a.zip"); await fs.writeFile(file, "not a zip"); await expect(inspectPackage(file)).rejects.toMatchObject({code: "invalid_package"});
    const m: any = mr(); m.dependencies["quilt-loader"] = "1"; await archive(file, m); await expect(inspectPackage(file)).rejects.toMatchObject({code: "unsupported_loader"});
    delete m.dependencies["quilt-loader"];
    m.files = [{path: "mods/a.jar", fileSize: 1, hashes: {sha1: "a".repeat(40), sha512: "b".repeat(128)}, downloads: ["http://127.0.0.1/a"]}];
    await archive(file, m); await expect(inspectPackage(file)).rejects.toMatchObject({code: "unsafe_download_url"});
  });
  it("rejects manifests missing hashes and preserves valid remote files", async () => {
    const file = path.join(dir, "a.mrpack"), m: any = mr();
    m.files = [{path: "mods/a.jar", fileSize: 1, hashes: {sha1: "a".repeat(40), sha512: "b".repeat(128)}, downloads: ["https://cdn.modrinth.com/a"], env: {client: "required", server: "required"}}];
    await archive(file, m); expect((await inspectPackage(file)).fileCount).toBe(1);
    delete m.files[0].hashes.sha512; await archive(file, m); await expect(inspectPackage(file)).rejects.toMatchObject({code: "invalid_package"});
  });
});
