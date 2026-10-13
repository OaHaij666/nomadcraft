import { createHash } from "crypto";
export interface DistributionFile {
  path: string;
  size: number;
  sha256: string;
  side: "client" | "server" | "both";
  ownership: "managed" | "seed";
}
export interface DistributionManifest {
  schema: 1;
  files: DistributionFile[];
}
export interface DistributionIdentity {
  serviceId: string;
  manifestVersions: number[];
  capabilities: string[];
}
export function distributionPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    /[\\:\x00-\x1f]/.test(value) ||
    value.startsWith("/")
  )
    throw new Error("unsafe_distribution_path");
  const parts = value.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    )
  )
    throw new Error("unsafe_distribution_path");
  if (
    ![
      "mods",
      "config",
      "defaultconfigs",
      "kubejs",
      "scripts",
      "datapacks",
      "resourcepacks",
      "shaderpacks"
    ].includes(parts[0]) ||
    parts.length < 2
  )
    throw new Error("unsupported_distribution_path");
  if (parts.some((p) => /^(?:\.env|launcher_accounts.json|accounts.json)$/i.test(p)))
    throw new Error("private_distribution_path");
  return value;
}
export function validateManifest(input: unknown, maxBytes = 5 * 1024 ** 3): DistributionManifest {
  const m = input as DistributionManifest;
  if (!m || m.schema !== 1 || !Array.isArray(m.files) || m.files.length > 20000)
    throw new Error("invalid_distribution_manifest");
  if (JSON.stringify(input).length > 2 * 1024 ** 2)
    throw new Error("invalid_distribution_manifest_size");
  let total = 0;
  const names = new Set<string>();
  const sizes = new Map<string, number>();
  const files = m.files
    .map((f) => {
      const p = distributionPath(f.path),
        key = p.normalize("NFC").toLowerCase();
      if (names.has(key)) throw new Error("duplicate_distribution_path");
      names.add(key);
      if (
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !["client", "server", "both"].includes(f.side) ||
        !["managed", "seed"].includes(f.ownership)
      )
        throw new Error("invalid_distribution_file");
      if (sizes.has(f.sha256) && sizes.get(f.sha256) !== f.size) throw new Error("invalid_distribution_hash_size");
      sizes.set(f.sha256, f.size);
      total += f.size;
      if (!Number.isSafeInteger(total) || total > maxBytes) throw new Error("distribution_quota_exceeded");
      return { path: p, size: f.size, sha256: f.sha256, side: f.side, ownership: f.ownership };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { schema: 1, files };
}
export function manifestDigest(m: DistributionManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(validateManifest(m, Number.MAX_SAFE_INTEGER)))
    .digest("hex");
}
export interface DistributionDiff {
  path: string;
  operation: "add" | "change" | "remove" | "same";
  conflict: boolean;
  current?: string;
  before?: string;
  next?: string;
}
export function diffManifest(
  previous: DistributionManifest | undefined,
  next: DistributionManifest,
  current: Record<string, string>
): DistributionDiff[] {
  const old = new Map(
      (previous?.files ?? []).filter((f) => f.side !== "server").map((f) => [f.path, f])
    ),
    fresh = new Map(next.files.filter((f) => f.side !== "server").map((f) => [f.path, f]));
  return [...new Set([...old.keys(), ...fresh.keys()])].sort().map((p) => {
    const a = old.get(p),
      b = fresh.get(p),
      c = current[p];
    const operation = !b ? "remove" : c === b.sha256 ? "same" : c ? "change" : "add";
    return {
      path: p,
      operation,
      conflict:
        (operation !== "same" && !!c && (!a || c !== a.sha256)) ||
        (!!b && b.ownership === "seed" && !!c && c !== b.sha256),
      current: c,
      before: a?.sha256,
      next: b?.sha256
    };
  });
}
