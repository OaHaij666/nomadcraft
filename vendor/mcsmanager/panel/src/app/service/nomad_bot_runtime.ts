import crypto from "crypto";
import fs from "fs";
import path from "path";
import { NumenHarness } from "../../../../../kamucl/src/main/core/numen/harness";
import {
  AiModelClient,
  modelEndpoint,
  type BrainMessage,
} from "../../../../../kamucl/src/main/core/numen/model";
import type { AiSettings, NumenPhase, NumenTool } from "../../../../../kamucl/src/shared/numen";
import type { BotRecord } from "../../../../shared/nomad-bots";
import { CatalogError } from "./nomad_catalog";
import { nomadBotTransport, type NomadBotTransport } from "./nomad_bot_transport";
function luaString(value: string): string {
  return (
    '"' +
    Array.from(Buffer.from(value, "utf8"))
      .map((byte) => "\\" + String(byte).padStart(3, "0"))
      .join("") +
    '"'
  );
}
export interface PublicBotConfig extends AiSettings {
  apiKey?: string;
  clearApiKey?: boolean;
}
export class BotCredentialVault {
  constructor(private directory = path.resolve("data/NomadBotSecrets")) {}
  private key(): Buffer {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "master.key");
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error("invalid_bot_credential_key");
    return key;
  }
  seal(value: string): string {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", this.key(), iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  open(value: string): string {
    const body = Buffer.from(value, "base64"),
      cipher = crypto.createDecipheriv("aes-256-gcm", this.key(), body.subarray(0, 12));
    cipher.setAuthTag(body.subarray(12, 28));
    return Buffer.concat([cipher.update(body.subarray(28)), cipher.final()]).toString("utf8");
  }
}
export function validatePublicBotConfig(input: any): PublicBotConfig {
  if (
    !input ||
    !["openai", "anthropic"].includes(input.protocol) ||
    typeof input.baseUrl !== "string" ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 200 ||
    typeof input.persona !== "string" ||
    input.persona.length > 12000 ||
    !Number.isInteger(input.maxTurns) ||
    input.maxTurns < 1 ||
    input.maxTurns > 100 ||
    !Number.isInteger(input.maxTokens) ||
    input.maxTokens < 256 ||
    input.maxTokens > 32768
  )
    throw new CatalogError(400, "invalid_public_bot_config");
  try {
    modelEndpoint(input.baseUrl, input.protocol);
  } catch {
    throw new CatalogError(400, "invalid_public_bot_endpoint");
  }
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== "string" || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey))
  )
    throw new CatalogError(400, "invalid_public_bot_key");
  return {
    protocol: input.protocol,
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
    persona: input.persona,
    maxTokens: input.maxTokens,
    maxTurns: input.maxTurns,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
  };
}
interface Runtime {
  epoch: number;
  brain: NumenHarness;
  phase: NumenPhase;
  key: string;
  logs: Array<{ time: number; kind: string; text: string }>;
}
export class NomadPublicBotRuntime {
  private runners = new Map<string, Runtime>();
  private locks = new Map<string, Promise<unknown>>();
  private starting = new Map<string, AbortController>();
  private generations = new Map<string, number>();
  constructor(
    private transport: NomadBotTransport = nomadBotTransport,
    private vault = new BotCredentialVault(),
    private directory = path.resolve("data/NomadBotHistory"),
  ) {}
  status(bot: BotRecord) {
    const run = this.runners.get(bot.id);
    return {
      phase: run?.phase ?? "stopped",
      epoch: run?.epoch,
      host: this.transport.status(bot.instanceId, bot.saveId).ready,
      logs: run?.logs ?? [],
    };
  }
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const job = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(id, job);
    void job
      .finally(() => {
        if (this.locks.get(id) === job) this.locks.delete(id);
      })
      .catch(() => {});
    return job;
  }
  async action(
    bot: BotRecord,
    config: AiSettings,
    sealed: string,
    input: { action: string; text?: string },
  ) {
    return this.serialize(bot.id, async () => {
      if (input.action === "stop-thinking") {
        await this.stop(bot.id);
        return { state: "stopped" };
      }
      if (input.action === "delete") {
        await this.stop(bot.id);
        await this.transport.call(bot.instanceId, bot.saveId, "delete", {
          name: bot.name,
          companion: bot.companionId,
          scope: "shared",
        });
        return { state: "deleted" };
      }
      if (input.action === "leave") {
        await this.stop(bot.id);
        await this.transport.call(bot.instanceId, bot.saveId, "leave", {
          name: bot.name,
          companion: bot.companionId,
          scope: "shared",
        });
        return { state: "left" };
      }
      let run = this.runners.get(bot.id);
      const host = this.transport.status(bot.instanceId, bot.saveId);
      const epoch = "epoch" in host ? Number(host.epoch) : 0;
      if (run && run.epoch !== epoch) {
        await this.stop(bot.id);
        run = undefined;
      }
      const generation = this.generations.get(bot.id) ?? 0;
      if (!run || ["error", "stopped"].includes(run.phase)) {
        if (!sealed) throw new CatalogError(409, "public_bot_api_key_required");
        const key = this.vault.open(sealed);
        const initializing = new AbortController();
        this.starting.set(bot.id, initializing);
        let joined: any;
        try {
          joined = await this.transport.call(
            bot.instanceId,
            bot.saveId,
            "join",
            { name: bot.name, scope: "shared", botId: bot.id },
            initializing.signal,
          );
          initializing.signal.throwIfAborted();
        } finally {
          if (this.starting.get(bot.id) === initializing) this.starting.delete(bot.id);
        }
        const companion = String(joined?.id ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(companion)) throw new Error("invalid_server_companion");
        bot.companionId = companion;
        if (bot.ysm) {
          const desired = luaString(bot.ysm.model);
          const receipt = await this.transport.call(bot.instanceId, bot.saveId, "lua", {
            name: bot.name,
            scope: "shared",
            companion,
            code:
              "ysm.model.switch(" +
              desired +
              ")\nlocal look = ysm.model.options()\nif look.current_model ~= " +
              desired +
              ' then error("YSM model did not apply") end\nprint(look.current_model)',
          });
          let result: any;
          try {
            result = typeof receipt === "string" ? JSON.parse(receipt) : receipt;
          } catch {
            throw new CatalogError(409, "bot_ysm_receipt_invalid");
          }
          if (result?.status !== "ok") throw new CatalogError(409, "bot_ysm_apply_failed");
        }

        if ((this.generations.get(bot.id) ?? 0) !== generation)
          throw new CatalogError(409, "bot_start_cancelled");
        const bridge = this.transport;
        const tools: NumenTool[] = [
          {
            name: "lua",
            description:
              "Execute Numen Lua on the server. Server-only APIs are supported; client-only calls return an explicit error. Use numen.api.help to inspect APIs.",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
          {
            name: "say",
            description: "Speak in game as the selected companion",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ];
        const body = {
          tools,
          instructions:
            "This is a dedicated-server Numen body. There is no owner client. Client-only Lua APIs are unavailable.",
          call: async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
            const result = await bridge.call(
              bot.instanceId,
              bot.saveId,
              name,
              { ...args, companion, name: bot.name, scope: "shared" },
              signal,
            );
            return {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result),
                },
              ],
            };
          },
        };
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, bot.id + ".json");
        let history: BrainMessage[] = [];
        if (fs.existsSync(file) && fs.statSync(file).size < 4 * 1024 * 1024) {
          try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Array.isArray(data)) history = data;
          } catch {}
        }
        const scrub = (text: string) =>
          text
            .split(key)
            .join("[已隐藏]")
            .replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]");
        const record: Runtime = { epoch, brain: undefined as any, phase: "ready", key, logs: [] };
        record.brain = new NumenHarness(
          body,
          new AiModelClient(config, key),
          companion,
          config,
          {
            log: (kind, text) => {
              record.logs.push({ time: Date.now(), kind, text: scrub(text).slice(0, 12000) });
              if (record.logs.length > 400) record.logs.shift();
            },
            phase: (phase) => {
              record.phase = phase;
            },
            usage: () => {},
            save: (history) => {
              const temporary = file + ".tmp";
              fs.writeFileSync(temporary, scrub(JSON.stringify(history)), { mode: 0o600 });
              fs.renameSync(temporary, file);
            },
          },
          history,
        );
        this.runners.set(bot.id, record);
        record.brain.start();
        run = record;
      }
      if (input.action === "message") run.brain.send(input.text ?? "");
      return { state: "running", companionId: bot.companionId };
    });
  }
  async stop(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.starting.get(id)?.abort();
    const run = this.runners.get(id);
    if (run) {
      await run.brain.stop();
      run.key = "";
    }
  }
}
export const botCredentialVault = new BotCredentialVault();
export const nomadPublicBotRuntime = new NomadPublicBotRuntime(
  nomadBotTransport,
  botCredentialVault,
);
