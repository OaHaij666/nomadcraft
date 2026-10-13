import Koa from "koa";
import { GlobalVariable } from "mcsmanager-common";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { ROLE, User } from "../entity/user";
import { $t } from "../i18n";
import { systemConfig } from "../setting";
import { checkSafeName } from "../utils/safe";
import {
  IP_BAN_DURATION_MS,
  IpFailureRecord,
  registerFailureAttempt,
  resetFailure
} from "./login_ban";
import { logger } from "./log";
import { timeUuid } from "./password";
import userSystem from "./user_service";

export const BAN_IP_COUNT = "banip";
export const LOGIN_FAILED_KEY = "loginFailed";
export const ILLEGAL_ACCESS_KEY = "illegalAccess";
export const LOGIN_COUNT = "loginCount";
export const LOGIN_FAILED_COUNT_KEY = "loginFailedCount";

// KAMUCL embeds the panel in an Electron iframe. Chromium may reject the
// panel's HttpOnly session cookie in that third-party iframe, so the existing
// session token is also accepted as a bearer credential for API requests.
// The map is deliberately process-local and expires with the normal session
// lifetime; it never stores passwords or exposes user data to the client.
const EMBEDDED_TOKEN_TTL = 86400000;
const embeddedTokens = new Map<string, { uuid: string; userName: string; expiresAt: number }>();

function rememberEmbeddedToken(token: string, user: User): void {
  embeddedTokens.set(token, { uuid: user.uuid, userName: user.userName, expiresAt: Date.now() + EMBEDDED_TOKEN_TTL });
}

export function embeddedTokenUser(ctx: Koa.ParameterizedContext): User | undefined {
  const token = ctx.get('Authorization').startsWith('Bearer ') ? ctx.get('Authorization').slice(7) : typeof ctx.query.token === 'string' ? ctx.query.token : '';
  if (!token) return undefined;
  const entry = embeddedTokens.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    embeddedTokens.delete(token);
    return undefined;
  }
  return userSystem.getInstance(entry.uuid) || undefined;
}

function forgetEmbeddedToken(token?: string): void {
  if (token) embeddedTokens.delete(token);
}

export function login(
  ctx: Koa.ParameterizedContext,
  userName: string,
  passWord: string,
  twoFACode?: string
): string {
  // record the number of login requests
  GlobalVariable.set(LOGIN_COUNT, GlobalVariable.get(LOGIN_COUNT, 0) + 1);
  const ip = getLoginIp(ctx);
  // check user information
  try {
    const totpDriftToleranceSteps = systemConfig?.totpDriftToleranceSteps || 0;
    userSystem.checkUser({ userName, passWord }, twoFACode, totpDriftToleranceSteps);

    // Session Session state changes to logged in
    return loginSuccess(ctx, userName);
  } catch (err) {
    // record the number of login failures
    GlobalVariable.set(LOGIN_FAILED_COUNT_KEY, GlobalVariable.get(LOGIN_FAILED_COUNT_KEY, 0) + 1);
    if (ctx.session) {
      ctx.session["login"] = null;
      ctx.session["token"] = null;
      ctx.session.save();
    }
    logger.info(`[LOGIN] IP: ${ip}, Try login ${userName} failed!`);
    throw err;
  }
}

export function loginSuccess(ctx: Koa.ParameterizedContext, userName: string) {
  const ip = getLoginIp(ctx);
  const user = userSystem.getUserByUserName(userName);
  if (!user) throw new Error($t("TXT_CODE_router.login.nameOrPassError"));
  if (!ctx.session) throw new Error("Session is Null!");

  // A successful authentication (password or SSO) resets this IP's failure
  // counter. All login paths funnel through here, so SSO resets it too.
  const ipMap = GlobalVariable.get(LOGIN_FAILED_KEY);
  if (ipMap) resetFailure(ipMap, ip || "");

  user.loginTime = new Date().toLocaleString();
  ctx.session["login"] = true;
  ctx.session["userName"] = userName;
  ctx.session["uuid"] = user.uuid;
  ctx.session["role"] = user.permission === 10 ? ROLE.ADMIN : ROLE.USER;
  ctx.session["token"] = timeUuid();
  rememberEmbeddedToken(String(ctx.session["token"]), user);
  ctx.session.save();

  logger.info($t("TXT_CODE_42036f92"));
  logger.info(`[LOGIN] IP: ${ip} Login ${userName} successful!`);
  logger.info('[LOGIN] Session created');
  logger.info($t("TXT_CODE_42036f92"));

  return String(ctx.session["token"]);
}

export function getLoginIp(ctx: Koa.ParameterizedContext) {
  return ctx.ip ?? "";
}

export async function bind2FA(ctx: Koa.ParameterizedContext) {
  if (!ctx.session) throw new Error("Session is Null!");
  const userName = ctx.session["userName"];
  const user = userSystem.getUserByUserName(userName);
  if (!user) throw new Error("User is Null!");
  try {
    const secret = authenticator.generateSecret();
    const qrCode = await QRCode.toDataURL(
      authenticator.keyuri(userName, "MCSManager Panel", secret)
    );
    userSystem.edit(user.uuid, { secret, open2FA: false });
    return qrCode;
  } catch (err) {
    user.secret = "";
  }
}

export async function confirm2FaQRCode(userUuid: string, isEnable: boolean) {
  await userSystem.edit(userUuid, {
    open2FA: isEnable
  });
}

export function check(ctx: Koa.ParameterizedContext) {
  if (!ctx.session) return false;
  if (ctx.session["login"] && ctx.session["userName"] && ctx.session["token"]) return true;
  return false;
}

export function logout(ctx: Koa.ParameterizedContext): boolean {
  if (!ctx.session) return false;
  forgetEmbeddedToken(String(ctx.session["token"] || ctx.query.token || ""));
  ctx.session["login"] = null;
  ctx.session["userName"] = null;
  ctx.session["uuid"] = null;
  ctx.session["token"] = null;
  ctx.session.maxAge = 0;
  ctx.session.save();
  return true;
}

export async function register(
  ctx: Koa.ParameterizedContext,
  userName: string,
  passWord: string,
  permission: number
) {
  let f = true;
  // Check for duplicate usernames.
  userSystem.objects.forEach((user) => {
    if (user && user.userName == userName) f = false;
  });
  if (f) {
    // Next. UUID and other data will be automatically generated.
    const { uuid } = await userSystem.create({
      userName,
      passWord,
      permission
    });

    return {
      uuid,
      userName,
      permission
    };
  }
  return false;
}

export function getUserPermission(ctx: Koa.ParameterizedContext): number {
  let user: User | undefined | null = undefined;
  if (isApiRequest(ctx)) {
    user = getUuidByApiKey(getApiKey(ctx));
  } else {
    user = embeddedTokenUser(ctx) || userSystem.getInstance(ctx.session?.["uuid"] || "");
  }
  if (!user) return 0;
  return user.permission ?? 0;
}

export function getUserNameBySession(ctx: Koa.ParameterizedContext): string {
  if (isApiRequest(ctx)) {
    const user = getUuidByApiKey(getApiKey(ctx));
    return user ? user.userName : "";
  }
  return embeddedTokenUser(ctx)?.userName || ctx.session?.["userName"];
}

export function getUserFromCtx(ctx: Koa.ParameterizedContext) {
  try {
    if (isApiRequest(ctx)) {
      const user = getUuidByApiKey(getApiKey(ctx));
      return user || undefined;
    }
    return embeddedTokenUser(ctx) || userSystem.getInstance(ctx.session?.["uuid"] || "") || undefined;
  } catch (error) {
    return undefined;
  }
}

export function getUserUuid(ctx: Koa.ParameterizedContext): string {
  if (isApiRequest(ctx)) {
    const user = getUuidByApiKey(getApiKey(ctx));
    if (user && user.uuid) {
      return user.uuid;
    } else {
      return "";
    }
  }
  return embeddedTokenUser(ctx)?.uuid || ctx.session?.["uuid"] || "";
}

export function getToken(ctx: Koa.ParameterizedContext): string {
  return (ctx.get('Authorization').startsWith('Bearer ') && ctx.get('Authorization').slice(7)) || (typeof ctx.query.token === 'string' && ctx.query.token) || ctx.session?.['token'] || '';
}

export function isAjax(ctx: Koa.ParameterizedContext) {
  return (
    ctx.header["x-requested-with"] &&
    ctx.header["x-requested-with"].toString().toLocaleLowerCase() === "xmlhttprequest"
  );
}

export function checkBanIp(ctx: Koa.ParameterizedContext) {
  if (!GlobalVariable.map.has(LOGIN_FAILED_KEY)) GlobalVariable.set(LOGIN_FAILED_KEY, {});
  // This IpMap also needs to be used when logging in
  const ipMap: Record<string, IpFailureRecord> = GlobalVariable.get(LOGIN_FAILED_KEY);

  const ip = getLoginIp(ctx);

  const { decision, newlyBanned } = registerFailureAttempt(ipMap, ip, {
    loginCheckIp: systemConfig?.loginCheckIp === true
  });

  if (newlyBanned) {
    // record the number of bans
    GlobalVariable.set(BAN_IP_COUNT, GlobalVariable.get(BAN_IP_COUNT, 0) + 1);
    // Once the ban window elapses, clean up the record and the ban counter.
    // Only remove the record if it is still the one we banned, so a stale timer
    // cannot wipe out a newer ban for the same IP.
    const bannedRecord = ipMap[ip];
    setTimeout(() => {
      if (ipMap[ip] === bannedRecord) delete ipMap[ip];
      GlobalVariable.set(BAN_IP_COUNT, Math.max(0, GlobalVariable.get(BAN_IP_COUNT, 1) - 1));
    }, IP_BAN_DURATION_MS);
  }

  return decision === "allow";
}

export function getUuidByApiKey(unsafeApiKey: string) {
  // Validate apiKey: only A-Z, a-z, 0-9 are allowed
  if (!checkSafeName(unsafeApiKey)) return null;
  const pageData = userSystem.getQueryWrapper().selectPage(
    {
      apiKey: unsafeApiKey
    },
    1,
    1
  );
  if (pageData.total === 1) {
    return pageData.data[0];
  }
  return null;
}

export function isApiRequest(ctx: Koa.ParameterizedContext) {
  return ctx.query.apikey || ctx.request?.header["x-request-api-key"] ? true : false;
}

export function getApiKey(ctx: Koa.ParameterizedContext) {
  return String(ctx.query.apikey || ctx.request?.header["x-request-api-key"] || "");
}
