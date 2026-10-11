import {
  DEFAULT_HOSTING_WILLINGNESS,
  isHostingWillingness
} from "../../../../shared/nomad-hosting-preference";
import Router from "@koa/router";
import Koa from "koa";
import { toBoolean } from "mcsmanager-common";
import { v4 } from "uuid";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { getInstancesByUuid } from "../service/instance_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import {
  bind2FA,
  confirm2FaQRCode,
  getToken,
  getUserFromCtx,
  getUserUuid,
  isAjax,
  logout
} from "../service/passport_service";
import { isTopPermissionByUuid } from "../service/permission_service";
import userSystem from "../service/user_service";
import { systemConfig } from "../setting";

const router = new Router({ prefix: "/auth" });

// [Low-level Permission]
// add token return
router.get(
  "/token",
  permission({ level: ROLE.USER, token: false, speedLimit: false }),
  async (ctx: Koa.ParameterizedContext) => {
    // Some and only Ajax requests can get the token
    if (isAjax(ctx)) {
      ctx.body = getToken(ctx);
    } else {
      throw new Error("The request is not an Ajax request.");
    }
  }
);

// [Low-level Permission]
// get user data
router.get("/", permission({ level: ROLE.USER, token: false, speedLimit: false }), async (ctx) => {
  // Default permission to get me
  let uuid = getUserUuid(ctx);
  // The front end can choose to require advanced data
  const advanced = ctx.query.advanced;

  // Admin permissions can be obtained from anyone
  if (isTopPermissionByUuid(uuid) && ctx.query.uuid) uuid = String(ctx.query.uuid);

  // Some and only Ajax requests grant access
  if (isAjax(ctx)) {
    const res = await getInstancesByUuid(uuid, undefined, toBoolean(advanced) || false);
    res.token = getToken(ctx);
    ctx.body = res;
  }
});

// Hosting preference is always scoped to the authenticated account.
router.get(
  "/hosting-preference",
  permission({ level: ROLE.USER, speedLimit: false }),
  async (ctx) => {
    const user = getUserFromCtx(ctx);
    if (!user) {
      ctx.status = 403;
      ctx.body = "authentication_required";
      return;
    }
    ctx.body = { hostingWillingness: user.hostingWillingness ?? DEFAULT_HOSTING_WILLINGNESS };
  }
);
router.put("/hosting-preference", permission({ level: ROLE.USER }), async (ctx) => {
  const user = getUserFromCtx(ctx),
    body = ctx.request.body;
  if (!user) {
    ctx.status = 403;
    ctx.body = "authentication_required";
    return;
  }
  if (
    Object.keys(ctx.query).some((key) => key !== "token" && key !== "_force") ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !isHostingWillingness(body.hostingWillingness)
  ) {
    ctx.status = 400;
    ctx.body = "invalid_hosting_preference";
    return;
  }
  await userSystem.setHostingWillingness(user.uuid, body.hostingWillingness);
  operationLogger.log("user_config_change", {
    ...getOperationLoggerOperator(ctx),
    target_user_name: user.userName
  });
  ctx.body = { hostingWillingness: user.hostingWillingness };
});

// [Low-level Permission]
// Modify personal user information
router.put("/update", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (userUuid) {
    const config = ctx.request.body;
    const { passWord, isInit } = config;
    if (!userSystem.validatePassword(passWord))
      throw new Error($t("TXT_CODE_router.user.passwordCheck"));
    const user = userSystem.getInstance(userUuid);
    await userSystem.edit(userUuid, { passWord, isInit });
    operationLogger.log("user_config_change", {
      ...getOperationLoggerOperator(ctx),
      target_user_name: user?.userName
    });
    ctx.body = logout(ctx);
  }
});

// [Low-level Permission]
// API generation and shutdown
router.put("/api", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  const enable = ctx.request.body.enable;
  const user = userSystem.getInstance(userUuid);
  let newKey = "";
  try {
    if (user) {
      if (enable) {
        const enableApiKey = systemConfig?.enableApiKey || false;
        if (!enableApiKey) throw new Error($t("TXT_CODE_db253979"));

        if (enableApiKey === "ONLY_ADMIN" && user.permission < ROLE.ADMIN)
          throw new Error($t("TXT_CODE_db253979"));

        newKey = v4().replace(/-/gim, "");
        await userSystem.edit(userUuid, {
          apiKey: newKey
        });
      } else {
        await userSystem.edit(userUuid, {
          apiKey: ""
        });
      }
      operationLogger.log(
        "user_apikey_change",
        {
          ...getOperationLoggerOperator(ctx),
          target_user_name: user.userName,
          enabled: Boolean(enable)
        },
        "warning"
      );
    }
    ctx.body = newKey;
  } catch (error: any) {
    ctx.body = error;
  }
});

// [Low-level Permission]
// 2FA
router.post("/bind2fa", permission({ level: 1 }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (userUuid) {
    const qrcode = await bind2FA(ctx);
    ctx.body = qrcode;
  }
});

// [Low-level Permission]
// 2FA
router.post(
  "/confirm2fa",
  permission({ level: 1 }),
  validator({ body: { enable: Boolean, TOTPCode: String } }),
  async (ctx: Koa.ParameterizedContext) => {
    const TOTPCode = ctx.request.body.TOTPCode;
    const MFAResult = userSystem.check2FA(TOTPCode, getUserFromCtx(ctx) ?? {}, 0);
    const enable = Boolean(ctx.request.body.enable);
    // NOTE (documented behavior): only ENABLING requires a valid code; the
    // frontend disable flow sends a placeholder "000000". A session holder can
    // therefore strip 2FA - recorded as a finding in the integration suite.
    if (enable && !MFAResult) {
      ctx.body = false;
      return;
    }
    const userUuid = getUserUuid(ctx);
    await confirm2FaQRCode(userUuid, enable);
    ctx.body = true;
  }
);

export default router;
