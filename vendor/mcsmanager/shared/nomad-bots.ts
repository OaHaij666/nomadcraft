export type BotScope = "private" | "shared";
export type BotAccessMode = "whitelist" | "all-except";
export interface BotAccess {
  mode: BotAccessMode;
  users: string[];
}
export interface BotRecord {
  id: string;
  instanceId: string;
  saveId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  companionId: string;
  skin?: { value: string; signature: string };
  ysm?: { model: string; texture?: string };
  scope: BotScope;
  access: BotAccess;
  revision: number;
  admission: "pending" | "approved" | "rejected";
  resourceApplications: string[];
  reviewedBy?: string;
  reviewReason?: string;
  createdAt: number;
  deletedAt?: number;
}
export interface BotView extends BotRecord {
  canControl: boolean;
  canManage: boolean;
  runner: "owner" | "server";
  runtime: "unavailable" | "owner-required" | "server-ready" | "host-required";
  hasApiKey?: boolean;
  model?: {
    protocol: string;
    baseUrl: string;
    model: string;
    persona: string;
    maxTokens: number;
    maxTurns: number;
  };
  minecraftUuid?: string;
}
export interface BotCommand {
  id: string;
  botId: string;
  userId: string;
  userName: string;
  action: "message" | "stop-thinking" | "delete";
  text?: string;
  createdAt: number;
  claimedAt?: number;
  finishedAt?: number;
  ok?: boolean;
  error?: string;
}
export function validateBotAccess(scope: BotScope, input: unknown): BotAccess {
  const value = input as BotAccess;
  if (
    !value ||
    !["whitelist", "all-except"].includes(value.mode) ||
    (scope === "private" && value.mode !== "whitelist") ||
    !Array.isArray(value.users) ||
    value.users.length > 500 ||
    value.users.some((id) => typeof id !== "string" || !id.trim() || id.length > 100)
  )
    throw new Error("invalid_bot_access");
  return { mode: value.mode, users: [...new Set(value.users)] };
}
/** Instance membership is checked separately before evaluating a bot's ACL. */
export function botControlAllowed(bot: BotRecord, userId: string): boolean {
  if (bot.admission !== "approved") return false;
  return true; // Instance membership and native Minecraft command permissions are checked separately.
}
