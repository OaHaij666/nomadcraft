<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { router } from "@/config/router";
import { t } from "@/lang/i18n";
import { loginPageInfo, loginUser, ssoConfig, type SsoPublicConfig } from "@/services/apis";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { sleep } from "@/tools/common";
import { markdownToHTML } from "@/tools/safe";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import {
  CheckCircleOutlined,
  LoadingOutlined,
  LockOutlined,
  LoginOutlined,
  UserOutlined
} from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import { onMounted, reactive, ref } from "vue";

const { state: pageInfoResult, execute } = loginPageInfo();
const ssoInfo = ref<SsoPublicConfig | null>(null);

const props = defineProps<{
  card?: LayoutCard;
}>();

const formData = reactive({
  username: "",
  password: "",
  code: ""
});

const { execute: login } = loginUser();
const { updateUserInfo, isAdmin, state: appConfig } = useAppStateStore();

const loginStep = ref(0);
const is2Fa = ref(false);

const handleLogin = async () => {
  if (!formData.username.trim() || !formData.password.trim()) {
    return message.error(t("TXT_CODE_c846074d"));
  }
  try {
    loginStep.value++;
    await sleep(600);
    const result = await login({
      data: formData
    });
    if (result.value === "NEED_2FA") {
      loginStep.value = 0;
      is2Fa.value = true;
      return;
    }
    is2Fa.value = false;
    await sleep(600);
    await handleNext();
  } catch (error: any) {
    loginStep.value = 0;
    reportErrorMsg(error);
  }
};

const handleNext = async () => {
  try {
    await updateUserInfo();
    loginStep.value++;
    await sleep(1000);
    loginSuccess();
  } catch (error: any) {
    console.error(error);
    loginStep.value = 0;
    Modal.error({
      title: t("TXT_CODE_da2fb99a"),
      content: t("TXT_CODE_6e718abe")
    });
  }
};

const loginSuccess = () => {
  loginStep.value++;
  if (isAdmin.value) {
    router.push({
      path: "/"
    });
  } else {
    router.push({ path: "/customer" });
  }
};

const handleSsoLogin = () => {
  window.location.href = "/api/auth/sso/authorize";
};

onMounted(async () => {
  await execute();
  if (!appConfig.isInstall) router.push({ path: "/install" });

  try {
    const res = await ssoConfig().execute();
    if (res.value) ssoInfo.value = res.value;
  } catch {
    // SSO config may not be available
  }

  if (ssoInfo.value?.enabled && ssoInfo.value?.autoRedirect) {
    const query = router.currentRoute.value.query;
    if (!query.sso_error && query.ssoAutoRedirect !== "false") {
      handleSsoLogin();
      return;
    }
  }

  const ssoError = router.currentRoute.value.query.sso_error;
  if (ssoError) {
    const ssoErrorDesc = router.currentRoute.value.query.sso_error_desc;
    const errorCode = String(ssoError);
    const ssoErrorTitles: Record<string, string> = {
      sso_init_failed: t("TXT_CODE_SSO_ERROR_INIT_FAILED"),
      sso_auth_failed: t("TXT_CODE_SSO_ERROR_AUTH_FAILED"),
      session_expired: t("TXT_CODE_SSO_ERROR_SESSION_EXPIRED"),
      invalid_sso_session: t("TXT_CODE_SSO_ERROR_SESSION_EXPIRED"),
      sso_session_expired: t("TXT_CODE_SSO_ERROR_SESSION_EXPIRED")
    };
    Modal.error({
      title: ssoErrorTitles[errorCode] || `${t("TXT_CODE_SSO_ERROR")}: ${errorCode}`,
      content: ssoErrorDesc ? String(ssoErrorDesc) : t("TXT_CODE_SSO_CALLBACK_FAIL")
    });
  }
});
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    :class="{
      logging: loginStep === 1,
      loginDone: loginStep === 3,
      'w-100': true,
      'h-100': true
    }"
  >
    <CardPanel class="login-panel">
      <template #body>
        <div v-show="loginStep === 0" class="login-panel-body">
          <!-- The wordmark is the page's only loud element; everything else
               around it stays quiet. -->
          <div class="nc-wordmark">
            <span class="nc-wordmark-name">NomadCraft</span>
            <span class="nc-wordmark-rule" aria-hidden="true"></span>
            <span class="nc-wordmark-tag">{{
              props.card?.title ? props.card?.title : t("TXT_CODE_3ba5ad")
            }}</span>
          </div>
          <!-- Two worlds, drawn only with type and a hairline: one awake on
               someone's machine, one asleep. This is the daily question, so it
               is what the first screen shows. -->
          <div class="nc-worldmarks" aria-hidden="true">
            <div class="world live">
              <span class="name"><span class="dot"></span>星河镇</span>
              <span class="meta">在 alex 的电脑上</span>
            </div>
            <div class="world asleep">
              <span class="name"><span class="dot"></span>老存档</span>
              <span class="meta">休眠中</span>
            </div>
          </div>
          <a-typography-paragraph class="mb-20">
            {{ t("TXT_CODE_5b60ad00") }}
          </a-typography-paragraph>
          <div class="account-input-container">
            <div v-if="ssoInfo?.enabled && ssoInfo?.onlyMode" class="sso-only-container">
              <a-typography-paragraph type="secondary" class="mb-20">
                {{ t("TXT_CODE_SSO_ONLY_MODE_WARN") }}
              </a-typography-paragraph>
              <a-button size="large" type="primary" block @click="handleSsoLogin">
                <template #icon>
                  <img
                    v-if="ssoInfo?.iconUrl"
                    :src="ssoInfo.iconUrl"
                    style="width: 16px; height: 16px; margin-right: 6px; vertical-align: middle"
                  />
                  <LoginOutlined v-else />
                </template>
                {{
                  ssoInfo?.providerName
                    ? t("TXT_CODE_SSO_LOGIN_BTN", { name: ssoInfo.providerName })
                    : t("TXT_CODE_SSO_LOGIN_BTN_DEFAULT")
                }}
              </a-button>
            </div>

            <template v-else>
              <form @submit.prevent>
                <div v-if="!is2Fa">
                  <a-input
                    v-model:value="formData.username"
                    class="account"
                    size="large"
                    name="mcsm-name-input"
                    :placeholder="t('TXT_CODE_80a560a1')"
                  >
                    <template #suffix>
                      <UserOutlined style="color: rgba(0, 0, 0, 0.45)" />
                    </template>
                  </a-input>
                  <a-input
                    v-model:value="formData.password"
                    class="mt-20 account"
                    type="password"
                    :placeholder="t('TXT_CODE_551b0348')"
                    size="large"
                    name="mcsm-pw-input"
                    @press-enter="handleLogin"
                  >
                    <template #suffix>
                      <LockOutlined style="color: rgba(0, 0, 0, 0.45)" />
                    </template>
                  </a-input>
                </div>
                <div v-else>
                  <a-input
                    v-model:value="formData.code"
                    class="mt-20 mb-20 account"
                    type="text"
                    :placeholder="t('TXT_CODE_7ac8b1d3')"
                    size="large"
                    autocomplete="off"
                    name="mcsm-pw-2fa"
                    @press-enter="handleLogin"
                  >
                    <template #suffix>
                      <LockOutlined style="color: rgba(0, 0, 0, 0.45)" />
                    </template>
                  </a-input>
                </div>
              </form>

              <div class="mt-24 flex-between align-center">
                <!-- Attribution to the upstream project is a licence
                     requirement; keep it, but keep it quiet. -->
                <div class="nc-attribution">
                  <div
                    v-if="pageInfoResult?.loginInfo"
                    class="global-markdown-html"
                    v-html="markdownToHTML(pageInfoResult?.loginInfo || '')"
                  ></div>
                  <span>
                    Powered by
                    <a href="https://mcsmanager.com" target="_blank" rel="noopener noreferrer">
                      MCSManager
                    </a>
                  </span>
                </div>
                <div class="justify-end">
                  <a-button
                    size="large"
                    type="primary"
                    style="min-width: 95px"
                    @click="handleLogin"
                  >
                    {{ t("TXT_CODE_d2c1a316") }}
                  </a-button>
                </div>
              </div>

              <div v-if="ssoInfo?.enabled && !ssoInfo?.onlyMode" class="sso-divider-section">
                <a-divider>{{ t("TXT_CODE_SSO_LOGIN_DIVIDER") }}</a-divider>
                <a-button size="large" block @click="handleSsoLogin">
                  <template #icon>
                    <img
                      v-if="ssoInfo?.iconUrl"
                      :src="ssoInfo.iconUrl"
                      style="width: 16px; height: 16px; margin-right: 6px; vertical-align: middle"
                    />
                    <LoginOutlined v-else />
                  </template>
                  {{
                    ssoInfo?.providerName
                      ? t("TXT_CODE_SSO_LOGIN_BTN", { name: ssoInfo.providerName })
                      : t("TXT_CODE_SSO_LOGIN_BTN_DEFAULT")
                  }}
                </a-button>
              </div>
            </template>
          </div>
        </div>
        <div v-show="loginStep === 1" class="login-panel-body flex-center">
          <div style="text-align: center">
            <LoadingOutlined class="logging-icon" :style="{ fontSize: '62px', fontWeight: 800 }" />
          </div>
        </div>
        <div v-show="loginStep >= 2" class="login-panel-body flex-center">
          <div style="text-align: center">
            <CheckCircleOutlined
              class="login-success-icon"
              :style="{
                fontSize: '62px',
                color: 'var(--color-green-6)'
              }"
            />
          </div>
        </div>
      </template>
    </CardPanel>
  </div>
</template>

<style lang="scss">
.account-input-container {
  input:-webkit-autofill {
    -webkit-text-fill-color: var(--color-gray-8) !important;
    -webkit-box-shadow: 0 0 0px 1000px transparent inset !important;
    background-color: transparent !important;
    background-image: none;
    transition: background-color 99999s ease-in-out 0s;
  }
  input {
    background-color: transparent;
    caret-color: #fff;
  }
}
</style>

<style lang="scss" scoped>
@import "@/assets/nomad-theme.scss";

// The login screen is the product''s first impression, so it opens with the one
// thing that is uniquely ours: two worlds, one already awake and one still
// asleep, drawn only with type and a hairline. No glitch, no glow, no gradient.

.login-panel {
  margin: 0 auto;
  width: 100%;
  background: transparent;
  border: none;
  box-shadow: none;
  transition: opacity var(--nc-dur) var(--nc-ease);
}

.login-panel-body {
  padding: 32px 28px 28px;
  min-height: 322px;
}

.nc-wordmark {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 26px;
}

.nc-wordmark-name {
  font-family: var(--nc-font-display);
  font-size: 40px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--nc-parchment);
}

.nc-wordmark-rule {
  height: 1px;
  width: 100%;
  background: var(--nc-haze);
}

.nc-wordmark-tag {
  font-family: var(--nc-font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--nc-mist);
}

// The two worlds are the memorable element: a live one carries an aurora mark,
// an asleep one is only an outline.
.nc-worldmarks {
  display: flex;
  gap: 18px;
  margin-bottom: 28px;
}

.nc-worldmarks .world {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: var(--nc-radius);
  border: var(--nc-hairline);
  background: rgba(18, 19, 28, 0.35);
}

.nc-worldmarks .world.live {
  border-color: var(--nc-aurora-dim);
}

.nc-worldmarks .world .name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--nc-parchment);
}

.nc-worldmarks .world .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nc-haze);
  flex-shrink: 0;
}

.nc-worldmarks .world.live .dot {
  background: var(--nc-aurora);
}

.nc-worldmarks .world .meta {
  font-family: var(--nc-font-mono);
  font-size: 11px;
  color: var(--nc-mist);
}

.logging-icon {
  color: var(--nc-aurora);
  animation: opacityAnimation 0.4s;
}

.login-success-icon {
  color: var(--nc-aurora) !important;
  animation: scaleAnimation 0.4s;
}

.account-input-container input {
  background-color: transparent;
}

@keyframes opacityAnimation {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@keyframes scaleAnimation {
  0% {
    transform: scale(0);
  }
  100% {
    transform: scale(1);
  }
}
</style>
