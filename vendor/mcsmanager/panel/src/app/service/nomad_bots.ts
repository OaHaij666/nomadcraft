import {
  botCredentialVault,
  validatePublicBotConfig,
  nomadPublicBotRuntime,
} from "./nomad_bot_runtime";
import { nomadBotTransport } from "./nomad_bot_transport";
import type { NomadModels } from "./nomad_models";
import crypto from "crypto";
import type { IStorage } from "../common/storage/storage_interface";
import { NomadCatalog, CatalogError } from "./nomad_catalog";
import type { CatalogActor } from "../../../../shared/nomad-catalog";
import {
  validateBotAccess,
  botControlAllowed,
  type BotRecord,
  type BotView,
  type BotCommand,
} from "../../../../shared/nomad-bots";
class BotState {
  configEntries: Array<[string, { settings: any; sealed: string }]> = [];
  identityEntries: Array<[string, string]> = [];
  enabledEntries: Array<[string, boolean]> = [];
  bots: BotRecord[] = [];
  runningPublic: string[] = [];
  commands: BotCommand[] = [];
  configs: Record<string, { settings: any; sealed: string }> = {};
  identities: Record<string, string> = {};
  links: Array<{
    code: string;
    userId: string;
    instanceId: string;
    saveId: string;
    expires: number;
  }> = [];
  enabled: Record<string, boolean> = {};
}
const fail = (status: number, code: string): never => {
  throw new CatalogError(status, code);
};
function reviewedSkin(input: any) {
  if (input === undefined || input === null) return undefined;
  if (
    typeof input.value !== "string" ||
    typeof input.signature !== "string" ||
    input.value.length > 16384 ||
    input.signature.length > 4096 ||
    !input.value ||
    !input.signature
  )
    fail(400, "invalid_bot_skin");
  try {
    const textures = JSON.parse(Buffer.from(input.value, "base64").toString("utf8")).textures;
    const url = new URL(textures.SKIN.url);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "textures.minecraft.net")
      fail(400, "invalid_bot_skin");
  } catch {
    fail(400, "invalid_bot_skin");
  }
  return { value: input.value, signature: input.signature };
}
/** No credentials or model replies are stored in the command queue. */
export class NomadBots {
  private queue: Promise<unknown> = Promise.resolve();
  private recovering = new Set<string>();
  private retryAt = new Map<string, number>();
  constructor(
    private storage: () => IStorage,
    private catalog: NomadCatalog,
    private models?: NomadModels,
    private publicRuntime = nomadPublicBotRuntime,
    private actorLookup?: (id:string)=>CatalogActor|null,
  ) {}
  private mutate<T>(action: (state: BotState) => T | Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      const state = (await this.storage().load("NomadBots", BotState, "bots")) ?? new BotState();
      state.runningPublic ??= [];
      // StorageSubsystem hydrates only predeclared object keys; arrays preserve dynamic IDs.
      if (state.configEntries?.length) state.configs = Object.fromEntries(state.configEntries);
      if (state.identityEntries?.length)
        state.identities = Object.fromEntries(state.identityEntries);
      if (state.enabledEntries?.length) state.enabled = Object.fromEntries(state.enabledEntries);
      const result = await action(state);
      state.configEntries = Object.entries(state.configs ?? {});
      state.identityEntries = Object.entries(state.identities ?? {});
      state.enabledEntries = Object.entries(state.enabled ?? {});
      await this.storage().store("NomadBots", "bots", state);
      return structuredClone(result);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  private async instance(actor: CatalogActor, id: string, saveId?: string) {
    const item = (await this.catalog.list(actor)).instances.find((i) => i.id === id);
    if (!item || (saveId && !item.saves.some((s) => s.id === saveId)))
      fail(403, "bot_instance_forbidden");
    return item!;
  }
  private manages(bot: BotRecord, actor: CatalogActor, instance: any) {
    return bot.scope === "private"
      ? bot.ownerId === actor.id
      : actor.admin || instance.permissions.includes("bots.manage");
  }
  private view(bot: BotRecord, actor: CatalogActor, instance: any, state?: BotState): BotView {
    return {
      ...bot,
      canControl: botControlAllowed(bot, actor.id),
      canManage: this.manages(bot, actor, instance),
      runner: bot.scope === "private" ? "owner" : "server",
      runtime:
        bot.scope === "private"
          ? "owner-required"
          : nomadBotTransport.status(bot.instanceId, bot.saveId).ready
          ? "server-ready"
          : "host-required",
      ...(state?.configs?.[bot.id]
        ? { hasApiKey: !!state.configs[bot.id].sealed, model: state.configs[bot.id].settings }
        : {}),
      ...(state?.identities?.[bot.instanceId + ":" + bot.saveId + ":" + bot.ownerId]
        ? { minecraftUuid: state.identities[bot.instanceId + ":" + bot.saveId + ":" + bot.ownerId] }
        : {}),
    };
  }
  async list(actor: CatalogActor, instanceId: string, saveId: string): Promise<BotView[]> {
    const instance = await this.instance(actor, instanceId, saveId);
    return this.mutate((state) =>
      state.bots
        .filter((b) => !b.deletedAt && b.instanceId === instanceId && b.saveId === saveId)
        .map((b) => this.view(b, actor, instance, state)),
    );
  }
  async create(actor: CatalogActor, input: any): Promise<BotView> {
    if (
      !input ||
      !["private", "shared"].includes(input.scope) ||
      typeof input.name !== "string" ||
      !/^[A-Za-z0-9_]{3,16}$/.test(input.name) ||
      typeof input.instanceId !== "string" ||
      typeof input.saveId !== "string"
    )
      fail(400, "invalid_bot");
    const instance = await this.instance(actor, input.instanceId, input.saveId);
    if (input.scope === "shared" && !instance.permissions.includes("bots.shared.create"))
      fail(403, "bot_creation_forbidden");
    const skin = reviewedSkin(input.skin);
    const config = input.scope === "shared" ? validatePublicBotConfig(input.model) : undefined;
    if (
      input.companionId &&
      (typeof input.companionId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.companionId))
    )
      fail(400, "invalid_companion_id");
    if (
      input.resourceApplications &&
      (!Array.isArray(input.resourceApplications) ||
        input.resourceApplications.length > 20 ||
        input.resourceApplications.some((id: unknown) => typeof id !== "string" || id.length > 100))
    )
      fail(400, "invalid_bot_resources");
    let ysm: { model: string; texture?: string } | undefined;
    if (input.resourceApplications?.length) {
      const all = await this.models?.list(actor, input.instanceId, input.saveId);
      if (!all || input.resourceApplications.some((id: string) => !all.some((a) => a.id === id)))
        fail(403, "bot_resources_unavailable");
      if (input.resourceApplications.length === 1) {
        const application = all!.find((a) => a.id === input.resourceApplications[0]);
        if (application && typeof application.name === "string" && application.name.length <= 1024)
          ysm = { model: application.name };
      }
    }
    const access = input.access
      ? validateBotAccess(input.scope, input.access)
      : { mode: "whitelist" as const, users: [] };
    return this.mutate((state) => {
      if (
        state.bots.some(
          (b) =>
            !b.deletedAt &&
            b.instanceId === input.instanceId &&
            b.saveId === input.saveId &&
            (b.name.toLowerCase() === input.name.toLowerCase() ||
              (!!input.companionId && b.companionId === input.companionId)),
        )
      )
        fail(409, "bot_already_registered");
      if (state.bots.filter((b) => !b.deletedAt && b.instanceId === input.instanceId).length >= 100)
        fail(409, "bot_limit");
      const bot: BotRecord = {
        id: crypto.randomUUID(),
        instanceId: input.instanceId,
        saveId: input.saveId,
        ownerId: actor.id,
        ownerName: actor.name,
        name: input.name,
        companionId: input.companionId || "",
        ...(skin ? { skin } : {}),
        ...(ysm ? { ysm } : {}),
        admission: "pending",
        resourceApplications: input.resourceApplications ?? [],
        scope: input.scope,
        access,
        revision: 1,
        createdAt: Date.now(),
      };
      if (config) {
        const { apiKey, clearApiKey, ...settings } = config;
        state.configs ??= {};
        state.configs[bot.id] = { settings, sealed: apiKey ? botCredentialVault.seal(apiKey) : "" };
      }
      state.bots.push(bot);
      return this.view(bot, actor, instance, state);
    });
  }
  async review(actor: CatalogActor, id: string, input: any) {
    return this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (!instance.permissions.includes("bots.approve")) fail(403, "bot_review_forbidden");
      if (
        !input ||
        input.revision !== bot.revision ||
        !["approve", "reject"].includes(input.decision)
      )
        fail(409, "invalid_bot_review");
      if (typeof input.reason !== "string" || input.reason.length > 1000)
        fail(400, "invalid_review_reason");
      if (bot.resourceApplications.length && input.decision === "approve") {
        const approved = await this.models?.approved(bot.instanceId, bot.saveId);
        if (!approved || bot.resourceApplications.some((id) => !approved.some((a) => a.id === id)))
          fail(409, "bot_resources_review_required");
      }
      bot.admission = input.decision === "approve" ? "approved" : "rejected";
      bot.reviewedBy = actor.id;
      bot.reviewReason = input.reason;
      bot.revision++;
      return this.view(bot, actor, instance, state);
    });
  }
  async bindCompanion(actor: CatalogActor, id: string, companionId: string) {
    if (typeof companionId !== "string" || !/^[0-9a-f-]{36}$/i.test(companionId))
      fail(400, "invalid_companion_id");
    return this.mutate(async (state) => {
      const bot = this.bot(state, id);
      await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.scope !== "private" || bot.ownerId !== actor.id || bot.admission !== "approved")
        fail(403, "bot_admission_required");
      if (bot.companionId && bot.companionId !== companionId)
        fail(409, "bot_companion_already_bound");
      if (
        state.bots.some(
          (other) =>
            !other.deletedAt &&
            other.id !== bot.id &&
            other.instanceId === bot.instanceId &&
            other.saveId === bot.saveId &&
            other.companionId === companionId,
        )
      )
        fail(409, "bot_already_registered");
      bot.companionId = companionId;
      bot.revision++;
      return { id: bot.id, companionId };
    });
  }
  private bot(state: BotState, id: string) {
    const bot = state.bots.find((b) => b.id === id && !b.deletedAt);
    if (!bot) fail(404, "bot_not_found");
    return bot!;
  }
  async access(actor: CatalogActor, id: string, input: any) {
    return this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (!this.manages(bot, actor, instance)) fail(403, "bot_management_forbidden");
      if (input?.revision !== bot.revision) fail(409, "bot_revision_conflict");
      bot.access = validateBotAccess(bot.scope, input.access);
      bot.revision++;
      return this.view(bot, actor, instance, state);
    });
  }
  async submit(actor: CatalogActor, id: string, input: any) {
    const queued = await this.enqueue(actor, id, input);
    if (queued.runner === "server")
      void this.executeShared(id, queued.id).catch(() =>
        this.mutate((state) => {
          const command = state.commands.find((c) => c.id === queued.id);
          if (command && !command.finishedAt) {
            command.finishedAt = Date.now();
            command.ok = false;
            command.error = "bot_action_cancelled";
          }
        }),
      );
    return queued;
  }
  private async enqueue(actor: CatalogActor, id: string, input: any) {
    if (
      !input ||
      !["message", "stop-thinking", "delete"].includes(input.action) ||
      (input.action === "message" &&
        (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000))
    )
      fail(400, "invalid_bot_command");
    return this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.admission !== "approved") fail(403, "bot_admission_required");
      if (bot.scope === "shared" && !state.enabled?.[bot.instanceId])
        fail(409, "bot_instance_disabled");
      if (input.action === "delete") {
        if (!this.manages(bot, actor, instance)) fail(403, "bot_management_forbidden");
        if (input.confirm !== "permanent") fail(400, "permanent_deletion_confirmation_required");
      } else if (!botControlAllowed(bot, actor.id)) fail(403, "bot_control_forbidden");

      const now = Date.now();
      state.commands = state.commands.filter((c) => now - c.createdAt < 86400000);
      if (state.commands.filter((c) => c.botId === id && !c.finishedAt).length >= 80)
        fail(429, "bot_queue_full");
      if (
        state.commands.filter((c) => c.userId === actor.id && now - c.createdAt < 10000).length >=
        20
      )
        fail(429, "bot_command_rate_limited");
      const command: BotCommand = {
        id: crypto.randomUUID(),
        botId: id,
        userId: actor.id,
        userName: actor.name,
        action: input.action,
        ...(input.action === "message" ? { text: input.text.trim() } : {}),
        createdAt: now,
      };
      state.commands.push(command);
      if (bot.scope === "shared" && input.action !== "message") state.runningPublic = state.runningPublic.filter(b => b !== id);
      return {
        id: command.id,
        state: "queued",
        runner: bot.scope === "shared" ? "server" : "owner",
      };
    });
  }
  async claim(actor: CatalogActor, id: string) {
    return this.mutate(async (state) => {
      const bot = this.bot(state, id);
      await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.scope !== "private" || bot.ownerId !== actor.id)
        fail(403, "bot_owner_runner_required");
      if (bot.admission !== "approved") fail(403, "bot_admission_required");
      // Expired claims are not replayed: model calls and deletions are not idempotent.
      const now = Date.now();
      for (const c of state.commands.filter(
        (c) => c.botId === id && c.claimedAt && !c.finishedAt && now - c.claimedAt! > 300000,
      )) {
        c.finishedAt = now;
        c.ok = false;
        c.error = "owner_runner_interrupted";
      }
      if (state.commands.some((c) => c.botId === id && c.claimedAt && !c.finishedAt)) return null;
      const command = state.commands.find((c) => c.botId === id && !c.claimedAt && !c.finishedAt);
      if (!command) return null;
      const caller = { id: command.userId, name: command.userName, admin: false };
      let allowed = false;
      try {
        const instance = await this.instance(caller, bot.instanceId, bot.saveId);
        allowed =
          command.action === "delete"
            ? this.manages(bot, caller, instance)
            : botControlAllowed(bot, command.userId);
      } catch {}
      if (!allowed) {
        command.finishedAt = now;
        command.ok = false;
        command.error = "bot_permission_revoked";
        return null;
      }
      if (now - command.createdAt > 300000) {
        command.finishedAt = now;
        command.ok = false;
        command.error = "bot_command_expired";
        return null;
      }
      command.claimedAt = now;
      return { ...command, companionId: bot.companionId };
    });
  }
  async complete(actor: CatalogActor, id: string, commandId: string, input: any) {
    return this.mutate(async (state) => {
      const bot = this.bot(state, id);
      await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.scope !== "private" || bot.ownerId !== actor.id)
        fail(403, "bot_owner_runner_required");
      if (bot.admission !== "approved") fail(403, "bot_admission_required");
      const command = state.commands.find(
        (c) => c.botId === id && c.id === commandId && c.claimedAt && !c.finishedAt,
      );
      if (!command || typeof input?.ok !== "boolean") fail(409, "invalid_bot_receipt");
      command!.finishedAt = Date.now();
      command!.ok = input.ok;
      // Receipts deliberately never store arbitrary error text which might contain credentials.
      if (!input.ok) command!.error = "owner_runner_failed";
      if (input.ok && command!.action === "delete") {
        bot.deletedAt = Date.now();
        bot.revision++;
      }
      return { ok: input.ok };
    });
  }
  private async executeShared(id: string, commandId: string) {
    const context = await this.mutate((state) => {
      const bot = this.bot(state, id),
        command = state.commands.find((c) => c.id === commandId);
      if (bot.admission !== "approved" || !state.enabled?.[bot.instanceId])
        fail(403, "bot_admission_required");
      if (!command) throw new Error("bot_command_missing");
      command.claimedAt = Date.now();
      if (["stop-thinking", "leave", "delete"].includes(command.action)) state.runningPublic = state.runningPublic.filter(b => b !== id);
      return { bot, command, config: state.configs?.[id] };
    });
    let ok = false,
      error = "";
    try {
      // Check membership again at delivery, as private owner runners do.
      const caller=this.actorLookup?this.actorLookup(context.command.userId):{id:context.command.userId,name:context.command.userName,admin:false};
      if(!caller)throw new CatalogError(403,"bot_instance_forbidden");
      await this.instance(caller,context.bot.instanceId,context.bot.saveId);
      if (!context.config) throw new Error("public_bot_configuration_required");
      await this.publicRuntime.action(
        context.bot,
        context.config.settings,
        context.config.sealed,
        context.command,
      );
      ok = true;
    } catch {
      error = "server_bot_action_failed";
    }
    await this.mutate((state) => {
      const bot = this.bot(state, id),
        command = state.commands.find((c) => c.id === commandId);
      if (command) {
        command.finishedAt = Date.now();
        command.ok = ok;
        command.error = error || undefined;
      }
      if (ok) {
        if (context.command.action === "message" && state.commands.filter(c => c.botId === id).slice(-1)[0]?.id === commandId && !state.runningPublic.includes(id)) state.runningPublic.push(id);
        bot.companionId = context.bot.companionId;
        if (context.command.action === "delete") {
          bot.deletedAt = Date.now();
          delete state.configs?.[id];
        }
      }
    });
  }
  async sharedConfig(actor: CatalogActor, id: string, input: any) {
    const config = validatePublicBotConfig(input);
    return this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.scope !== "shared" || !this.manages(bot, actor, instance))
        fail(403, "bot_management_forbidden");
      if (input.revision !== bot.revision) fail(409, "bot_revision_conflict");
      state.runningPublic = state.runningPublic.filter(b => b !== id);
      await this.publicRuntime.stop(id);
      const { apiKey, clearApiKey, ...settings } = config;
      state.configs ??= {};
      const old = state.configs[id];
      state.configs[id] = {
        settings,
        sealed: clearApiKey
          ? ""
          : apiKey !== undefined
          ? apiKey
            ? botCredentialVault.seal(apiKey)
            : ""
          : old?.sealed ?? "",
      };
      bot.revision++;
      return this.view(bot, actor, instance, state);
    });
  }
  async runtime(actor: CatalogActor, id: string) {
    return this.mutate(async (state) => {
      const bot = this.bot(state, id);
      await this.instance(actor, bot.instanceId, bot.saveId);
      return {
        ...this.publicRuntime.status(bot),
        commands: state.commands
          .filter((c) => c.botId === id)
          .slice(-30)
          .map((c) => ({
            id: c.id,
            action: c.action,
            createdAt: c.createdAt,
            finishedAt: c.finishedAt,
            ok: c.ok,
            error: c.error,
          })),
      };
    });
  }
  async setEnabled(actor: CatalogActor, instanceId: string, enabled: boolean) {
    const instance = await this.instance(actor, instanceId);
    if (!instance.permissions.includes("mods.manage")) fail(403, "bot_enable_forbidden");
    if (typeof enabled !== "boolean") fail(400, "invalid_bot_enable");
    return this.mutate(async (state) => {
      state.enabled ??= {};
      state.enabled[instanceId] = enabled;
      if (!enabled) state.runningPublic = state.runningPublic.filter(id => !state.bots.some(b => b.id === id && b.instanceId === instanceId));
      if (!enabled)
        for (const bot of state.bots.filter(
          (b) => b.instanceId === instanceId && !b.deletedAt && b.scope === "shared",
        ))
          await this.publicRuntime.stop(bot.id);
      return { enabled };
    });
  }
  async instanceSettings(actor: CatalogActor, instanceId: string) {
    await this.instance(actor, instanceId);
    return this.mutate((state) => ({ enabled: state.enabled?.[instanceId] ?? false }));
  }
  async link(actor: CatalogActor, instanceId: string, saveId: string) {
    await this.instance(actor, instanceId, saveId);
    return this.mutate((state) => {
      state.links ??= [];
      state.links = state.links.filter((l) => l.expires > Date.now() && l.userId !== actor.id);
      const code = crypto.randomBytes(16).toString("hex");
      state.links.push({
        code,
        userId: actor.id,
        instanceId,
        saveId,
        expires: Date.now() + 300000,
      });
      return { code, expires: Date.now() + 300000 };
    });
  }
  async hostPolicy(instanceId: string, saveId: string, links: any[] = []) {
    return this.mutate((state) => {
      state.identities ??= {};
      state.links ??= [];
      for (const link of links.slice(0, 100)) {
        const pending = state.links.find(
          (p) =>
            p.code === link.code &&
            p.instanceId === instanceId &&
            p.saveId === saveId &&
            p.expires > Date.now(),
        );
        if (pending && typeof link.uuid === "string" && /^[0-9a-f-]{36}$/i.test(link.uuid)) {
          state.identities[instanceId + ":" + saveId + ":" + pending.userId] = link.uuid;
          state.links = state.links.filter((p) => p !== pending);
        }
      }
      return {
        enabled: state.enabled?.[instanceId] ?? false,
        bots: state.bots
          .filter(
            (b) =>
              !b.deletedAt &&
              b.instanceId === instanceId &&
              b.saveId === saveId &&
              b.admission === "approved",
          )
          .map((b) => ({
            id: b.id,
            name: b.name,
            scope: b.scope,
            companionId: b.companionId,
            ownerUuid: state.identities[instanceId + ":" + saveId + ":" + b.ownerId] ?? "",
            skin: b.skin ?? null,
          })),
      };
    });
  }

  async bodyAction(actor: CatalogActor, id: string, action: string) {
    if (!["join", "leave"].includes(action)) fail(400, "invalid_bot_body_action");
    const context = await this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (bot.admission !== "approved") fail(403, "bot_admission_required");
      if (bot.scope === "private" && bot.ownerId !== actor.id) fail(403, "bot_owner_required");
      if (!state.enabled?.[bot.instanceId]) fail(409, "bot_instance_disabled");
      if (action === "leave") state.runningPublic = state.runningPublic.filter(b => b !== id);
      return { bot, config: state.configs?.[id] };
    });
    let result: any;
    if (context.bot.scope === "shared") {
      if (!context.config) fail(409, "public_bot_configuration_required");
      result = await this.publicRuntime.action(
        context.bot,
        context.config!.settings,
        context.config!.sealed,
        { action },
      );
    } else
      result = await nomadBotTransport.call(context.bot.instanceId, context.bot.saveId, action, {
        name: context.bot.name,
        scope: "private",
        botId: id,
      });
    if (action === "join")
      await this.mutate((state) => {
        const bot = this.bot(state, id);
        bot.companionId = context.bot.scope === "shared" ? context.bot.companionId : result.id;
        bot.revision++;
        if (bot.scope === "shared" && !state.runningPublic.includes(id)) state.runningPublic.push(id);
      });
    return result;
  }
  async hostStopped(instanceId: string, saveId: string, epoch: number) {
    if (nomadBotTransport.offline(instanceId, saveId, epoch))
      await this.reconcilePublic(instanceId, saveId);
  }
  async reconcilePublic(instanceId: string, saveId: string) {
    const desired = await this.mutate(state => state.bots
      .filter(bot => bot.scope === "shared" && bot.instanceId === instanceId && bot.saveId === saveId && !bot.deletedAt)
      .map(bot => ({bot, busy: state.commands.some(c => c.botId === bot.id && !c.finishedAt && Date.now() - c.createdAt < 300000), config: state.configs[bot.id], wanted: state.enabled[instanceId] === true && bot.admission === "approved" && state.runningPublic.includes(bot.id)})));
    const host = nomadBotTransport.status(instanceId, saveId);
    for (const item of desired) {
      const current = this.publicRuntime.status(item.bot);
      if (!item.wanted || !host.ready) {
        if (current.phase !== "stopped") await this.publicRuntime.stop(item.bot.id);
        continue;
      }
      if (item.busy) continue;
      const epoch = "epoch" in host ? Number(host.epoch) : 0;
      if (current.epoch === epoch && !["stopped", "error"].includes(current.phase)) continue;
      if (this.recovering.has(item.bot.id) || (this.retryAt.get(item.bot.id) ?? 0) > Date.now()) continue;
      this.recovering.add(item.bot.id);
      try {
        if (!item.config?.sealed) continue;
        const owner=this.actorLookup?this.actorLookup(item.bot.ownerId):{id:item.bot.ownerId,name:item.bot.ownerName,admin:false};
        if(!owner)throw new CatalogError(403,"bot_instance_forbidden");
        await this.instance(owner, instanceId, saveId);
        await this.publicRuntime.action(item.bot, item.config.settings, item.config.sealed, {action:"join"});
        const keep = await this.mutate(state => {
          const fresh = state.bots.find(b => b.id === item.bot.id && !b.deletedAt);
          if (!fresh || fresh.revision !== item.bot.revision || fresh.admission !== "approved" || !state.enabled[instanceId] || !state.runningPublic.includes(item.bot.id)) return false;
          fresh.companionId = item.bot.companionId;
          return true;
        });
        if (!keep) await this.publicRuntime.stop(item.bot.id);
        this.retryAt.delete(item.bot.id);
      } catch {
        this.retryAt.set(item.bot.id, Date.now() + 10000);
      } finally { this.recovering.delete(item.bot.id); }
    }
  }
  async roster(actor: CatalogActor, instanceId: string, saveId: string) {
    await this.instance(actor, instanceId, saveId);
    return nomadBotTransport.status(instanceId, saveId);
  }

  async appearance(actor: CatalogActor, id: string, input: any) {
    const skin = reviewedSkin(input.skin);
    return this.mutate(async (state) => {
      const bot = this.bot(state, id),
        instance = await this.instance(actor, bot.instanceId, bot.saveId);
      if (!this.manages(bot, actor, instance)) fail(403, "bot_management_forbidden");
      if (input.revision !== bot.revision) fail(409, "bot_revision_conflict");
      bot.skin = skin;
      bot.admission = "pending";
      delete bot.reviewedBy;
      bot.reviewReason = "";
      bot.revision++;
      state.runningPublic = state.runningPublic.filter(b => b !== id);
      await this.publicRuntime.stop(id);
      return this.view(bot, actor, instance, state);
    });
  }
}
