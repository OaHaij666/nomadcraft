import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { cloudClient } from "./nomadCloud";
import { confinedFile, fileDigest } from "./cloudSyncFiles";
import { validateManifest } from "../../../../mcsmanager/shared/nomad-distribution";
import { withFileJob } from "./fileJobs";
/** Only reviewed model resources may be copied into a cloud client. */
export async function syncApprovedModels(
  client: ReturnType<typeof cloudClient>,
  ref: { instanceId: string; saveId?: string },
  directory: string,
  signal?: AbortSignal,
) {
  if (!ref.saveId) return;
  const apps = await client.json(
    "api/nomad/bots/models?instanceId=" +
      encodeURIComponent(ref.instanceId) +
      "&saveId=" +
      encodeURIComponent(ref.saveId),
    { signal },
  );
  for (const application of apps.filter((a: any) => a.status === "approved")) {
    const manifest = validateManifest(application.manifest, 256 * 1024 * 1024);
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      if (!file.path.startsWith("config/yes_steve_model/custom/"))
        throw new Error("云端模型资源路径无效");
      const dest = await confinedFile(directory, file.path);
      await withFileJob(dest, signal, async () => {
        const existing = await fs.stat(dest).catch(() => null);
        if (existing) {
          if (
            !existing.isFile() ||
            existing.size !== file.size ||
            (await fileDigest(dest)) !== file.sha256
          )
            throw new Error("已审核模型与本地同名资源冲突：" + file.path);
          return;
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const part = dest + ".nc-" + crypto.randomUUID() + ".part";
        try {
          const response = await client.raw(
            "api/nomad/bots/models/" +
              encodeURIComponent(application.id) +
              "/blobs/" +
              file.sha256,
            { signal },
          );
          if (!response.body) throw new Error("云端模型资源为空");
          let size = 0;
          const digest = crypto.createHash("sha256");
          await pipeline(
            Readable.fromWeb(response.body as any),
            async function* (stream) {
              for await (const chunk of stream) {
                size += chunk.length;
                if (size > file.size) throw new Error("模型资源超过声明大小");
                digest.update(chunk);
                yield chunk;
              }
            },
            createWriteStream(part, { flags: "wx" }),
            { signal },
          );
          if (size !== file.size || digest.digest("hex") !== file.sha256)
            throw new Error("模型下载校验失败");
          signal?.throwIfAborted();
          await fs.link(part, dest);
        } finally {
          await fs.unlink(part).catch(() => {});
        }
      });
    }
  }
}
