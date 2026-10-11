<script setup lang="ts">
import { ct } from "@/hooks/useCatalog";
import LeftMenusPanel from "@/components/LeftMenusPanel.vue";
import Loading from "@/components/Loading.vue";
import { router } from "@/config/router";
import { SUPPORTED_LANGS, getCurrentLang, isCN, t } from "@/lang/i18n";
import {
  getPanelUpgradeInfo,
  setSettingInfo,
  settingInfo,
  upgradePanel,
  type IUpgradeInfo
} from "@/services/apis";
import { arrayFilter } from "@/tools/array";
import { pickLocalizedNotes } from "@/tools/localizedNotes";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard, Settings } from "@/types";
import {
  ApiOutlined,
  BankOutlined,
  BookOutlined,
  BugOutlined,
  CloudUploadOutlined,
  FileProtectOutlined,
  GithubOutlined,
  LockOutlined,
  MessageOutlined,
  MoneyCollectOutlined,
  ProjectOutlined,
  QuestionCircleOutlined,
  ReloadOutlined
} from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, onUnmounted, ref } from "vue";

defineProps<{
  card: LayoutCard;
}>();

const { execute, isReady } = settingInfo();
const { execute: submitExecute, isLoading: submitIsLoading } = setSettingInfo();

interface MySettings extends Settings {
  proLicenseKey?: string;
}

const ApacheLicense = `Copyright ${new Date().getFullYear()} MCSManager

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

const formData = ref<MySettings>();

const ssoSnapshot = ref({
  ssoType: "",
  ssoIssuer: "",
  ssoUserinfoUrl: "",
  ssoUserIdField: ""
});

const submit = async (needReload: boolean = true) => {
  if (formData.value) {
    try {
      await submitExecute({
        data: {
          ...formData.value
        }
      });
      message.success(t("TXT_CODE_a7907771"));
      if (needReload) setTimeout(() => window.location.reload(), 600);
    } catch (error: any) {
      reportErrorMsg(error);
    }
  }
};

const menus = arrayFilter([
  {
    title: t("TXT_CODE_cdd555be"),
    key: "baseInfo",
    icon: ProjectOutlined
  },
  {
    title: t("TXT_CODE_AUTOUPDATE_TAB_TITLE"),
    key: "autoUpdate",
    icon: CloudUploadOutlined
  },

  {
    title: t("TXT_CODE_9c3ca8f"),
    key: "security",
    icon: LockOutlined
  },
  {
    title: t("TXT_CODE_ea1600d2"),
    key: "audit",
    icon: FileProtectOutlined
  },
  {
    title: t("TXT_CODE_SSO_TAB_TITLE"),
    key: "sso",
    icon: ApiOutlined
  },

  {
    title: t("TXT_CODE_46cb40d5"),
    key: "sponsor",
    icon: MoneyCollectOutlined,
    condition: () => !isCN(),
    click: () => {
      let url = "https://www.patreon.com/mcsmanager";
      if (isCN()) url = "https://afdian.com/a/mcsmanager";
      window.open(url, "_blank");
    }
  },
  {
    title: t("TXT_CODE_3b4b656d"),
    key: "about",
    icon: QuestionCircleOutlined
  }
]);

const allLanguages = SUPPORTED_LANGS;

const allYesNo = [
  {
    label: t("TXT_CODE_52c8a730"),
    value: true
  },
  {
    label: t("TXT_CODE_718c9310"),
    value: false
  }
];

const apiKeyAccessOptions = [
  {
    label: t("TXT_CODE_52c8a730"),
    value: true
  },
  {
    label: t("TXT_CODE_675e5397"),
    value: "ONLY_ADMIN"
  },
  {
    label: t("TXT_CODE_718c9310"),
    value: false
  }
];

const totpDriftOptions = ref([
  {
    label: t("TXT_CODE_718c9310"),
    value: 0
  },
  {
    label: "30 s",
    value: 1
  },
  {
    label: "60 s",
    value: 2
  }
]);

const aboutLinks = arrayFilter([
  {
    title: "GitHub",
    icon: GithubOutlined,
    url: "https://github.com/MCSManager/MCSManager"
  },
  {
    title: "Discord",
    icon: MessageOutlined,
    url: "https://discord.gg/BNpYMVX7Cd"
  }
]);

const contacts = arrayFilter([
  {
    title: t("TXT_CODE_41dd4d19"),
    icon: BankOutlined,
    url: "https://mcsmanager.com/"
  },
  {
    title: t("TXT_CODE_74c3d3e5"),
    icon: BookOutlined,
    url: "https://docs.mcsmanager.com/"
  },
  {
    title: t("TXT_CODE_26407d1f"),
    icon: BugOutlined,
    url: "https://github.com/MCSManager/MCSManager/issues"
  }
]);

const ssoMode = computed({
  get(): string {
    const fd = formData.value as any;
    if (!fd?.ssoEnabled) return "disabled";
    return fd.ssoType === "oauth2" ? "oauth2" : "oidc";
  },
  set(val: string) {
    const fd = formData.value as any;
    if (!fd) return;
    if (val === "disabled") {
      fd.ssoEnabled = false;
    } else {
      fd.ssoEnabled = true;
      fd.ssoType = val;
    }
  }
});

const isSsoIdentityChanged = (): boolean => {
  const fd = formData.value as any;
  if (!fd) return false;
  const snap = ssoSnapshot.value;
  const curType = fd.ssoType || "oidc";
  if (curType !== snap.ssoType) return true;
  if (curType === "oidc" && (fd.ssoIssuer || "") !== snap.ssoIssuer) return true;
  if (curType === "oauth2") {
    if ((fd.ssoUserinfoUrl || "") !== snap.ssoUserinfoUrl) return true;
    if ((fd.ssoUserIdField || "id") !== snap.ssoUserIdField) return true;
  }
  return false;
};

const doSubmitSso = async () => {
  await submit(false);
  const fd = formData.value as any;
  if (fd) {
    ssoSnapshot.value = {
      ssoType: fd.ssoType || "oidc",
      ssoIssuer: fd.ssoIssuer || "",
      ssoUserinfoUrl: fd.ssoUserinfoUrl || "",
      ssoUserIdField: fd.ssoUserIdField || "id"
    };
  }
};

const submitSso = async () => {
  const fd = formData.value as any;
  if (fd?.ssoEnabled) {
    if (!fd.ssoClientId?.trim()) {
      return message.error(t("TXT_CODE_SSO_ENABLE_REQUIRES_CONFIG"));
    }
    if (fd.ssoType === "oauth2") {
      if (!fd.ssoAuthorizeUrl?.trim() || !fd.ssoTokenUrl?.trim() || !fd.ssoUserinfoUrl?.trim()) {
        return message.error(t("TXT_CODE_SSO_OAUTH2_REQUIRES_URLS"));
      }
    } else {
      if (!fd.ssoIssuer?.trim()) {
        return message.error(t("TXT_CODE_SSO_ENABLE_REQUIRES_CONFIG"));
      }
    }
  }
  if (isSsoIdentityChanged()) {
    Modal.confirm({
      title: t("TXT_CODE_SSO_IDENTITY_CHANGE_TITLE"),
      content: t("TXT_CODE_SSO_IDENTITY_CHANGE_CONFIRM"),
      okType: "danger",
      async onOk() {
        await doSubmitSso();
      }
    });
    return;
  }
  await doSubmitSso();
};

const leftMenusPanelRef = ref<InstanceType<typeof LeftMenusPanel>>();

// ---- Panel self-update (web) ----
const panelUpgradeInfo = ref<IUpgradeInfo>();
const panelUpgradeLoading = ref(false);

// Release notes of the online version, matched against the current panel
// language (falls back to English when that locale is missing).
const panelUpgradeNotes = computed(() =>
  pickLocalizedNotes(panelUpgradeInfo.value?.onlineNotes, getCurrentLang())
);

const refreshPanelUpgradeInfo = async () => {
  if (panelUpgradeLoading.value) return;
  panelUpgradeLoading.value = true;
  try {
    const { execute } = getPanelUpgradeInfo();
    panelUpgradeInfo.value = (await execute({})).value;
  } catch (error: any) {
    // silent: keep last known state
  } finally {
    panelUpgradeLoading.value = false;
  }
};

const onUpdateWeb = () => {
  Modal.confirm({
    title: t("TXT_CODE_AUTOUPDATE_WEB_BTN"),
    content: t("TXT_CODE_AUTOUPDATE_WEB_CONFIRM"),
    okText: t("TXT_CODE_AUTOUPDATE_BTN_OK"),
    cancelText: t("TXT_CODE_AUTOUPDATE_BTN_CANCEL"),
    onOk: async () => {
      try {
        const { execute } = upgradePanel();
        const res = await execute({});
        if (!res.value?.started) {
          message.info(res.value?.message || t("TXT_CODE_AUTOUPDATE_ALREADY_LATEST"));
          return;
        }
        // Update files are applied on disk; the panel is NOT restarted
        // automatically. Ask the operator to restart it manually.
        Modal.success({
          content: t("TXT_CODE_AUTOUPDATE_WEB_SUCCESS", { v: res.value.onlineVersion })
        });
      } catch (error: any) {
        reportErrorMsg(error?.message ? error.message : t("TXT_CODE_AUTOUPDATE_WEB_FAILED"));
      }
    }
  });
};

onMounted(async () => {
  const res = await execute();
  formData.value = res.value!;
  const fd = formData.value as any;
  ssoSnapshot.value = {
    ssoType: fd.ssoType || "oidc",
    ssoIssuer: fd.ssoIssuer || "",
    ssoUserinfoUrl: fd.ssoUserinfoUrl || "",
    ssoUserIdField: fd.ssoUserIdField || "id"
  };
  setTimeout(() => {
    if (router.currentRoute.value.query.tab === "pro") {
      leftMenusPanelRef.value?.setActiveKey("pro");
    }
  }, 100);

  refreshPanelUpgradeInfo();
});

onUnmounted(() => {
  const route = router.currentRoute.value;
  router.replace({
    query: {
      ...route.query,
      tab: undefined
    }
  });
});
</script>

<template>
  <div>
    <CardPanel v-if="isReady && formData" class="CardWrapper" style="height: 100%" :padding="false">
      <template #body>
        <LeftMenusPanel ref="leftMenusPanelRef" :menus="menus">
          <template #baseInfo>
            <section class="settings-section">
              <a-typography-title :level="4">{{ ct("UPLOAD_SETTINGS") }}</a-typography-title>
              <p>{{ ct("UPLOAD_SETTINGS_NOTE") }}</p>
              <a-form layout="vertical"><a-form-item :label="ct('UPLOAD_MAX_GIB')"><a-input-number v-model:value="formData.nomadPackageUploadGiB" :min="0.01" :max="1024" :step="1" :precision="2" addon-after="GiB" /></a-form-item></a-form>
              <a-form layout="vertical"><a-form-item :label="ct('HOST_RELAY_HOST')"><a-input v-model:value="formData.nomadRelayPublicHost" placeholder="127.0.0.1" :maxlength="255" /></a-form-item><a-form-item :label="ct('HOST_RELAY_BIND')"><a-input v-model:value="formData.nomadRelayBindIp" placeholder="127.0.0.1" :maxlength="255" /></a-form-item></a-form><p>{{ct('HOST_RELAY_NOTE')}}</p>
              <a-button type="primary" :loading="submitIsLoading" @click="submit(false)">{{ ct("SAVE") }}</a-button>
            </section>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_5206cf41") }}
              </a-typography-title>
              <div style="text-align: left">
                <a-form :model="formData" layout="vertical">
                  <a-form-item>
                    <a-typography-title :level="5">{{ t("TXT_CODE_a1a59b08") }}</a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_2abeb185") }}
                        <br />
                        {{ t("TXT_CODE_d648ff91") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select v-model:value="formData.language" style="max-width: 320px">
                      <a-select-option
                        v-for="item in allLanguages"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">{{ t("TXT_CODE_7f0017d2") }}</a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_233624ad") }}
                    </a-typography-paragraph>
                    <a-input
                      v-model:value="formData.httpPort"
                      style="max-width: 320px"
                      :placeholder="t('TXT_CODE_4ea93630')"
                    />
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">{{ t("TXT_CODE_514e064a") }}</a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_328191e") }}
                    </a-typography-paragraph>
                    <a-input
                      v-model:value="formData.httpIp"
                      style="max-width: 320px"
                      :placeholder="t('TXT_CODE_4ea93630')"
                    />
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">Panel ID</a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_e2976753") }}
                      <br />
                      <span v-if="formData.panelId">
                        {{ t("TXT_CODE_e56cced3") }}
                      </span>
                      <span v-else>
                        {{ t("TXT_CODE_699b4b66") }}
                      </span>
                    </a-typography-paragraph>
                    <a-input
                      v-model:value="formData.panelId"
                      :placeholder="t('TXT_CODE_4ea93630')"
                    />
                  </a-form-item>

                  <div class="button">
                    <a-button type="primary" :loading="submitIsLoading" @click="submit()">
                      {{ t("TXT_CODE_abfe9512") }}
                    </a-button>
                  </div>
                </a-form>
              </div>
            </div>
          </template>

          <template #security>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_9c3ca8f") }}
              </a-typography-title>
              <div style="text-align: left">
                <a-form :model="formData" layout="vertical">
                  <a-typography-title :level="5">
                    {{ t("TXT_CODE_ef0ce2e") }}
                  </a-typography-title>
                  <a-typography-paragraph>
                    <a-typography-text type="secondary">
                      {{ t("TXT_CODE_fcde7b2e") }}
                      <br />
                      {{ t("TXT_CODE_af19b7b5") }}
                    </a-typography-text>
                  </a-typography-paragraph>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_95192169") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_820260c5") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select
                      v-model:value.prop="(formData as any).enableApiKey"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in apiKeyAccessOptions"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_a583cae4") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_bfbdf579") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select
                      v-model:value.prop="(formData as any).allowChangeCmd"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_adab942e") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_ceb783a9") }}
                        <br />
                        {{ t("TXT_CODE_e5b7522d") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select
                      v-model:value.prop="(formData as any).canFileManager"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_3c93920b") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_bc2e52a0") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select
                      v-model:value.prop="(formData as any).allowUsePreset"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_405cd346") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_6655c905") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-select
                      v-model:value.prop="(formData as any).crossDomain"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_gzip_compress") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_gzip_compress_desc") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-select v-model:value.prop="(formData as any).gzip" style="max-width: 320px">
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_f0789d81") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_2b85af6d") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-select
                      v-model:value.prop="(formData as any).reverseProxyMode"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item v-show="(formData as any).reverseProxyMode">
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_66aeac82") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_fd8bc51f") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-input
                      v-model:value="(formData as any).reverseProxyHeader"
                      style="max-width: 320px"
                      :placeholder="t('TXT_CODE_4ea93630')"
                    />
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_1d67c9c6") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_745fc959") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-select
                      v-model:value.prop="(formData as any).loginCheckIp"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_b026be33") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_a77b1a21") }}
                      </a-typography-text>
                    </a-typography-paragraph>

                    <a-select
                      v-model:value="formData.totpDriftToleranceSteps"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in totpDriftOptions"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <div class="button">
                    <a-button type="primary" :loading="submitIsLoading" @click="submit(false)">
                      {{ t("TXT_CODE_abfe9512") }}
                    </a-button>
                  </div>
                </a-form>
              </div>
            </div>
          </template>

          <template #audit>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_ea1600d2") }}
              </a-typography-title>
              <div style="text-align: left">
                <a-form :model="formData" layout="vertical">
                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_3c7c9297") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_16a4e557") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-select
                      v-model:value.prop="(formData as any).operationLogEnabled"
                      style="max-width: 320px"
                    >
                      <a-select-option
                        v-for="item in allYesNo"
                        :key="item.value"
                        :value="item.value"
                      >
                        {{ item.label }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_186e1ce1") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_3effdfb0") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <div class="audit-scope-list">
                      <div class="audit-scope-item">
                        <span class="mr-8">{{ t("TXT_CODE_dbbaf16e") }}</span>
                        <a-checkbox v-model:checked="(formData as any).operationLogRecordLogin" />
                      </div>
                      <div class="audit-scope-item">
                        <span class="mr-8">{{ t("TXT_CODE_b68c8da6") }}</span>
                        <a-checkbox
                          v-model:checked="(formData as any).operationLogRecordInstance"
                        />
                      </div>
                      <div class="audit-scope-item">
                        <span class="mr-8">{{ t("TXT_CODE_95495db") }}</span>
                        <a-checkbox v-model:checked="(formData as any).operationLogRecordFile" />
                      </div>
                      <div class="audit-scope-item">
                        <span class="mr-8">{{ t("TXT_CODE_500fed5c") }}</span>
                        <a-checkbox v-model:checked="(formData as any).operationLogRecordUser" />
                      </div>
                      <div class="audit-scope-item">
                        <span class="mr-8">{{ t("TXT_CODE_36b3a6b") }}</span>
                        <a-checkbox v-model:checked="(formData as any).operationLogRecordSystem" />
                      </div>
                    </div>
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_68f99fdf") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_507be396") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-input-number
                      v-model:value="formData.operationLogMaxLinesPerFile"
                      style="max-width: 320px; width: 100%"
                      :min="10"
                      :max="1000"
                      :step="10"
                    />
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_dda5f944") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_8d88f625") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-input-number
                      v-model:value="formData.operationLogKeepDays"
                      style="max-width: 320px; width: 100%"
                      :min="0"
                      :max="3650"
                    />
                  </a-form-item>

                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_706b201e") }}
                    </a-typography-title>
                    <a-typography-paragraph>
                      <a-typography-text type="secondary">
                        {{ t("TXT_CODE_7ef4ecf4") }}
                      </a-typography-text>
                    </a-typography-paragraph>
                    <a-input-number
                      v-model:value="formData.operationLogMaxTotalLines"
                      style="max-width: 320px; width: 100%"
                      :min="0"
                      :max="1000000"
                      :step="1000"
                    />
                  </a-form-item>

                  <div class="button">
                    <a-button type="primary" :loading="submitIsLoading" @click="submit(false)">
                      {{ t("TXT_CODE_abfe9512") }}
                    </a-button>
                  </div>
                </a-form>
              </div>
            </div>
          </template>

          <template #sso>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_SSO_TAB_TITLE") }}
              </a-typography-title>
              <div style="text-align: left">
                <a-form :model="formData" layout="vertical">
                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_SSO_ENABLE") }}
                    </a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_SSO_ENABLE_DESC") }}
                    </a-typography-paragraph>
                    <a-select v-model:value="ssoMode" style="max-width: 320px">
                      <a-select-option value="disabled">
                        {{ t("TXT_CODE_718c9310") }}
                      </a-select-option>
                      <a-select-option value="oidc">OpenID Connect (OIDC)</a-select-option>
                      <a-select-option value="oauth2">OAuth 2.0</a-select-option>
                    </a-select>
                  </a-form-item>

                  <template v-if="(formData as any).ssoEnabled">
                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_PROVIDER_NAME") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_PROVIDER_NAME_DESC") }}
                      </a-typography-paragraph>
                      <a-input
                        v-model:value="(formData as any).ssoProviderName"
                        style="max-width: 320px"
                        :placeholder="t('TXT_CODE_4ea93630')"
                      />
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_ICON_URL") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_ICON_URL_DESC") }}
                      </a-typography-paragraph>
                      <a-input
                        v-model:value="(formData as any).ssoIconUrl"
                        style="max-width: 320px"
                        :placeholder="t('TXT_CODE_4ea93630')"
                      />
                    </a-form-item>

                    <!-- OIDC-specific: Issuer URL -->
                    <a-form-item v-if="ssoMode === 'oidc'">
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_ISSUER") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_ISSUER_DESC") }}
                      </a-typography-paragraph>
                      <a-input
                        v-model:value="(formData as any).ssoIssuer"
                        style="max-width: 480px"
                        placeholder="https://accounts.example.com"
                      />
                    </a-form-item>

                    <!-- OAuth 2.0-specific fields -->
                    <template v-if="ssoMode === 'oauth2'">
                      <a-form-item>
                        <a-typography-title :level="5">
                          {{ t("TXT_CODE_SSO_AUTHORIZE_URL") }}
                        </a-typography-title>
                        <a-typography-paragraph type="secondary">
                          {{ t("TXT_CODE_SSO_AUTHORIZE_URL_DESC") }}
                        </a-typography-paragraph>
                        <a-input
                          v-model:value="(formData as any).ssoAuthorizeUrl"
                          style="max-width: 480px"
                          placeholder="https://github.com/login/oauth/authorize"
                        />
                      </a-form-item>

                      <a-form-item>
                        <a-typography-title :level="5">
                          {{ t("TXT_CODE_SSO_TOKEN_URL") }}
                        </a-typography-title>
                        <a-typography-paragraph type="secondary">
                          {{ t("TXT_CODE_SSO_TOKEN_URL_DESC") }}
                        </a-typography-paragraph>
                        <a-input
                          v-model:value="(formData as any).ssoTokenUrl"
                          style="max-width: 480px"
                          placeholder="https://github.com/login/oauth/access_token"
                        />
                      </a-form-item>

                      <a-form-item>
                        <a-typography-title :level="5">
                          {{ t("TXT_CODE_SSO_USERINFO_URL") }}
                        </a-typography-title>
                        <a-typography-paragraph type="secondary">
                          {{ t("TXT_CODE_SSO_USERINFO_URL_DESC") }}
                        </a-typography-paragraph>
                        <a-input
                          v-model:value="(formData as any).ssoUserinfoUrl"
                          style="max-width: 480px"
                          placeholder="https://api.github.com/user"
                        />
                      </a-form-item>

                      <a-form-item>
                        <a-typography-title :level="5">
                          {{ t("TXT_CODE_SSO_USER_ID_FIELD") }}
                        </a-typography-title>
                        <a-typography-paragraph type="secondary">
                          {{ t("TXT_CODE_SSO_USER_ID_FIELD_DESC") }}
                        </a-typography-paragraph>
                        <a-input
                          v-model:value="(formData as any).ssoUserIdField"
                          style="max-width: 320px"
                          placeholder="id"
                        />
                      </a-form-item>

                      <a-form-item>
                        <a-typography-title :level="5">
                          {{ t("TXT_CODE_SSO_SCOPES") }}
                        </a-typography-title>
                        <a-typography-paragraph type="secondary">
                          {{ t("TXT_CODE_SSO_SCOPES_DESC") }}
                        </a-typography-paragraph>
                        <a-input
                          v-model:value="(formData as any).ssoScopes"
                          style="max-width: 320px"
                          placeholder="read:user"
                        />
                      </a-form-item>
                    </template>

                    <a-form-item>
                      <a-typography-title :level="5">Client ID</a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_CLIENT_ID_DESC") }}
                      </a-typography-paragraph>
                      <a-input
                        v-model:value="(formData as any).ssoClientId"
                        style="max-width: 480px"
                        :placeholder="t('TXT_CODE_4ea93630')"
                      />
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">Client Secret</a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_CLIENT_SECRET_DESC") }}
                      </a-typography-paragraph>
                      <a-input-password
                        v-model:value="(formData as any).ssoClientSecret"
                        style="max-width: 480px"
                        :placeholder="t('TXT_CODE_4d6e44c')"
                      />
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_b25b5335") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_9a26aa70") }}
                      </a-typography-paragraph>
                      <a-select
                        v-model:value="(formData as any).ssoTokenAuthMethod"
                        style="max-width: 320px"
                      >
                        <a-select-option value="auto">{{ t("TXT_CODE_dc8de4ff") }}</a-select-option>
                        <a-select-option value="client_secret_basic">
                          client_secret_basic
                        </a-select-option>
                        <a-select-option value="client_secret_post">
                          client_secret_post
                        </a-select-option>
                      </a-select>
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_CALLBACK_URL") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_CALLBACK_URL_DESC") }}
                      </a-typography-paragraph>
                      <a-input
                        v-model:value="(formData as any).ssoCallbackUrl"
                        style="max-width: 480px"
                        placeholder="https://your-panel.com/api/auth/sso/callback"
                      />
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_ONLY_MODE") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_ONLY_MODE_DESC") }}
                      </a-typography-paragraph>
                      <a-select
                        v-model:value.prop="(formData as any).ssoOnlyMode"
                        style="max-width: 320px"
                      >
                        <a-select-option
                          v-for="item in allYesNo"
                          :key="item.value"
                          :value="item.value"
                        >
                          {{ item.label }}
                        </a-select-option>
                      </a-select>
                    </a-form-item>

                    <a-form-item>
                      <a-typography-title :level="5">
                        {{ t("TXT_CODE_SSO_AUTO_REDIRECT") }}
                      </a-typography-title>
                      <a-typography-paragraph type="secondary">
                        {{ t("TXT_CODE_SSO_AUTO_REDIRECT_DESC") }}
                      </a-typography-paragraph>
                      <a-select
                        v-model:value.prop="(formData as any).ssoAutoRedirect"
                        style="max-width: 320px"
                      >
                        <a-select-option
                          v-for="item in allYesNo"
                          :key="item.value"
                          :value="item.value"
                        >
                          {{ item.label }}
                        </a-select-option>
                      </a-select>
                    </a-form-item>
                  </template>

                  <div class="button">
                    <a-button type="primary" :loading="submitIsLoading" @click="submitSso">
                      {{ t("TXT_CODE_abfe9512") }}
                    </a-button>
                  </div>
                </a-form>
              </div>
            </div>
          </template>

          <template #autoUpdate>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_AUTOUPDATE_TAB_TITLE") }}
              </a-typography-title>
              <div style="text-align: left">
                <a-form :model="formData" layout="vertical">
                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_TITLE") }}
                    </a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_TITLE_DESC") }}
                    </a-typography-paragraph>
                    <div class="flex" style="gap: 12px; flex-wrap: wrap">
                      <template v-if="panelUpgradeInfo">
                        <a-typography-text strong>
                          v{{ panelUpgradeInfo.currentVersion }}
                        </a-typography-text>
                        <a-tag v-if="!panelUpgradeInfo.configured" color="default">
                          {{ t("TXT_CODE_AUTOUPDATE_WEB_NOT_CONFIGURED") }}
                        </a-tag>
                        <template v-else>
                          <a-tag v-if="panelUpgradeInfo.updateAvailable" color="processing">
                            {{
                              t("TXT_CODE_AUTOUPDATE_WEB_LATEST", {
                                v: panelUpgradeInfo.onlineVersion
                              })
                            }}
                          </a-tag>
                          <a-tag v-else color="success">
                            {{ t("TXT_CODE_AUTOUPDATE_UP_TO_DATE") }}
                          </a-tag>
                        </template>
                      </template>
                      <a-button
                        size="small"
                        :loading="panelUpgradeLoading"
                        @click="refreshPanelUpgradeInfo"
                      >
                        <template #icon><ReloadOutlined /></template>
                        {{ t("TXT_CODE_AUTOUPDATE_BTN_REFRESH") }}
                      </a-button>
                    </div>
                    <div
                      v-if="panelUpgradeInfo?.updateAvailable && panelUpgradeNotes"
                      class="update-notes-box"
                    >
                      <div class="update-notes-title">
                        {{ t("TXT_CODE_AUTOUPDATE_WEB_NOTES") }}
                      </div>
                      <div class="update-notes-body">{{ panelUpgradeNotes }}</div>
                    </div>
                  </a-form-item>
                  <a-form-item>
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_BTN") }}
                    </a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_ACTION_DESC") }}
                    </a-typography-paragraph>
                    <a-button
                      type="primary"
                      danger
                      :disabled="
                        !panelUpgradeInfo?.configured || !panelUpgradeInfo?.updateAvailable
                      "
                      @click="onUpdateWeb"
                    >
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_BTN") }}
                    </a-button>
                  </a-form-item>
                  <a-form-item v-if="formData">
                    <a-typography-title :level="5">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_SOURCE") }}
                    </a-typography-title>
                    <a-typography-paragraph type="secondary">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_SOURCE_DESC") }}
                    </a-typography-paragraph>
                    <a-input
                      v-model:value="formData.updateSourceUrl"
                      style="max-width: 480px"
                      :placeholder="t('TXT_CODE_AUTOUPDATE_WEB_SOURCE_PH')"
                    />
                  </a-form-item>

                  <div class="button mb-24">
                    <a-button type="primary" :loading="submitIsLoading" @click="submit(false)">
                      {{ t("TXT_CODE_AUTOUPDATE_WEB_SAVE") }}
                    </a-button>
                  </div>
                </a-form>
              </div>
            </div>
          </template>
          <template #about>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_3b4b656d") }}
              </a-typography-title>
              <a-typography-paragraph>
                <p>
                  {{ $t("TXT_CODE_d0c670df") }}
                </p>
              </a-typography-paragraph>
              <div class="pb-4 flex">
                <div v-for="item in aboutLinks" :key="item.url" class="mr-12 mb-12">
                  <a :href="item.url" target="_blank">
                    <a-button>
                      <component :is="item.icon" />
                      {{ item.title }}
                    </a-button>
                  </a>
                </div>
              </div>
              <a-typography-paragraph>
                <p>
                  {{ $t("TXT_CODE_97433ac4") }}
                </p>
              </a-typography-paragraph>
              <div class="pb-4 flex">
                <div v-for="item in contacts" :key="item.url" class="mr-12 mb-12">
                  <a :href="item.url" target="_blank">
                    <a-button>
                      <component :is="item.icon" />
                      {{ item.title }}
                    </a-button>
                  </a>
                </div>
              </div>
              <a-typography-paragraph>
                <p>
                  {{ $t("TXT_CODE_e57bd50f") }}
                </p>
                <pre style="font-size: 13px">{{ ApacheLicense }}</pre>
              </a-typography-paragraph>
            </div>
          </template>

          <template #sponsor>
            <div class="content-box" :style="{ maxHeight: card.height }">
              <a-typography-title :level="4" class="mb-24">
                {{ t("TXT_CODE_46cb40d5") }}
              </a-typography-title>
              <a-typography-paragraph>
                <p>
                  {{ $t("TXT_CODE_d0c670df") }}
                </p>
              </a-typography-paragraph>
            </div>
          </template>
        </LeftMenusPanel>
      </template>
    </CardPanel>
    <div v-if="!isReady" class="loading flex-center w-100 h-100">
      <Loading></Loading>
    </div>
  </div>
</template>

<style lang="scss" scoped>
div {
  position: relative;
  .loading {
    position: absolute;
    top: 0;
    left: 0;
  }
}

.content-box {
  padding: 16px;
  overflow-y: auto;
}

.audit-scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;

  .audit-scope-item {
    display: flex;
    align-items: center;
  }
}

.update-notes-box {
  margin-top: 12px;
  max-width: 640px;
  padding: 12px;
  border-radius: 6px;
  background: var(--color-gray-2);
  border: 1px solid var(--color-gray-4);
}

.update-notes-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.update-notes-body {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
