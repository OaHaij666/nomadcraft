export interface ResourceSource {
  provider: "modrinth" | "curseforge";
  url: string;
}

/** Only public, credential-free platform CDNs can be used as resource sources. */
export function resourceSource(input: unknown): ResourceSource | undefined {
  const s = input as ResourceSource;
  if (!s || typeof s.url !== "string" || s.url.length > 2048) return;
  try {
    const u = new URL(s.url);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return;
    if (s.provider === "modrinth" && u.hostname === "cdn.modrinth.com" && u.pathname.startsWith("/data/"))
      return { provider: s.provider, url: u.href };
    if (s.provider === "curseforge" && ["edge.forgecdn.net", "media.forgecdn.net", "mediafilez.forgecdn.net"].includes(u.hostname) && u.pathname.startsWith("/files/"))
      return { provider: s.provider, url: u.href };
  } catch { /* Invalid metadata is not a download source. */ }
}

export function publicResourcePath(p: string): boolean {
  return /^(mods\/[^/]+\.jar|(?:resourcepacks|shaderpacks)\/[^/]+\.zip)$/i.test(p);
}

/** Match the exact file in a version, never its primary/latest file by assumption. */
export function modrinthSource(version: any, sha512: string, size: number): ResourceSource | undefined {
  if (!Array.isArray(version?.files)) return;
  for (const file of version.files) {
    if (file?.hashes?.sha512 === sha512 && file.size === size) {
      const source = resourceSource({ provider: "modrinth", url: file.url });
      if (source) return source;
    }
  }
}
