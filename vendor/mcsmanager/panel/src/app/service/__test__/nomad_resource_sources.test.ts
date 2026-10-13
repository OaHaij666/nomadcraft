import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { NomadResourceSources } from "../nomad_resource_sources";
import { DistributionFile } from "../../../../../shared/nomad-distribution";
const bytes = Buffer.from("exact upstream resource");
const hash = (algorithm: string) => crypto.createHash(algorithm).update(bytes).digest("hex");
const file: DistributionFile = { path: "mods/example.jar", size: bytes.length, sha256: hash("sha256"), side: "both", ownership: "managed" };
const source = { provider: "modrinth", url: "https://cdn.modrinth.com/data/project/versions/version/file.jar" };
const response = { [hash("sha512")]: { files: [
  { size: bytes.length, url: source.url.replace("file.jar", "wrong.jar"), hashes: { sha512: "0".repeat(128) }, primary: true },
  { size: bytes.length, url: source.url, hashes: { sha512: hash("sha512") } }
] } };
async function fixture(run: (blob: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nc-source-")), blob = path.join(directory, file.sha256);
  await fs.writeFile(blob, bytes);
  try { await run(blob); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
describe("automatic resource source discovery", () => {
  it("queries exact content, chooses matching file and caches metadata", () => fixture(async blob => {
    const calls: string[][] = [];
    const resolver = new NomadResourceSources(async hashes => { calls.push(hashes); return response; });
    expect(await resolver.resolve([file], () => blob)).toEqual({ [file.sha256]: [source] });
    expect(await resolver.resolve([file], () => blob)).toEqual({ [file.sha256]: [source] });
    expect(calls).toEqual([[hash("sha512")]]);
  }));
  it("never sends config, private or server-only file hashes to the platform", () => fixture(async blob => {
    let calls = 0;
    const resolver = new NomadResourceSources(async () => { calls++; return response; });
    expect(await resolver.resolve([{ ...file, path: "config/private.json" }, { ...file, side: "server" }], () => blob)).toEqual({});
    expect(calls).toBe(0);
  }));
  it("does not query corrupt cloud bytes and rejects wrong upstream hash or size", () => fixture(async blob => {
    let calls = 0;
    const resolver = new NomadResourceSources(async () => { calls++; return response; });
    await fs.writeFile(blob, Buffer.alloc(bytes.length));
    expect(await resolver.resolve([file], () => blob)).toEqual({}); expect(calls).toBe(0);
    await fs.writeFile(blob, bytes);
    const wrong = new NomadResourceSources(async () => ({ [hash("sha512")]: { files: [{ size: bytes.length + 1, url: source.url, hashes: { sha512: hash("sha512") } }] } }));
    expect(await wrong.resolve([file], () => blob)).toEqual({ [file.sha256]: [] });
  }));
  it("failed identification allows cloud fallback and negatively caches the failure", () => fixture(async blob => {
    let calls = 0;
    const resolver = new NomadResourceSources(async () => { calls++; throw Error("offline"); });
    expect(await resolver.resolve([file], () => blob)).toEqual({ [file.sha256]: [] });
    expect(await resolver.resolve([file], () => blob)).toEqual({ [file.sha256]: [] }); expect(calls).toBe(1);
  }));
  it("many players sharing the same release share a single in-flight lookup", () => fixture(async blob => {
    let calls = 0;
    const resolver = new NomadResourceSources(async () => { calls++; return response; });
    const results = await Promise.all(Array.from({ length: 10 }, () => resolver.resolve([file], () => blob)));
    expect(calls).toBe(1);
    for (const result of results) expect(result).toEqual({ [file.sha256]: [source] });
  }));
  it("known public sources require no platform query", () => fixture(async blob => {
    const resolver = new NomadResourceSources(async () => { throw Error("unexpected query"); });
    expect(await resolver.resolve([{ ...file, sources: [{ ...source, provider: "modrinth" }] }], () => blob)).toEqual({ [file.sha256]: [source] });
  }));
});
