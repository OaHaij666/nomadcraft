<script setup lang="ts">
import { router } from "@/config/router";
import { getInitLanguage, initInstallPageFlow, setLanguage, SUPPORTED_LANGS, t } from "@/lang/i18n";
import { panelInstall } from "@/services/apis";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import { reactive, ref } from "vue";
const formData = reactive({ username: "", password: "", language: getInitLanguage() });
const loading = ref(false);
const { updatePanelStatus, updateUserInfo } = useAppStateStore();
const createUser = async () => {
  if (loading.value) return;
  loading.value = true;
  try {
    await initInstallPageFlow(formData.language);
    setLanguage(formData.language, false);
    await panelInstall().execute({ data: formData });
    await updatePanelStatus();
    await updateUserInfo();
    await router.push("/catalog");
    window.location.reload();
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    loading.value = false;
  }
};
</script>
<template>
  <div class="initial-account">
    <div class="account-panel">
      <span class="wordmark">NomadCraft</span>
      <h1>{{ t("TXT_CODE_WORLD_ADMIN_CREATE") }}</h1>
      <a-form :model="formData" layout="vertical" @finish="createUser">
        <a-form-item
          name="username"
          :label="t('TXT_CODE_80a560a1')"
          :rules="[{ required: true, whitespace: true, message: t('TXT_CODE_2695488c') }]"
        >
          <a-input v-model:value="formData.username" autocomplete="username" />
        </a-form-item>
        <a-form-item
          name="password"
          :label="t('TXT_CODE_551b0348')"
          :rules="[
            {
              required: true,
              pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{9,36}$/,
              message: t('TXT_CODE_ad533c70')
            }
          ]"
        >
          <a-input-password v-model:value="formData.password" autocomplete="new-password" />
        </a-form-item>
        <a-form-item :label="t('TXT_CODE_a1a59b08')">
          <a-select v-model:value="formData.language">
            <a-select-option
              v-for="language in SUPPORTED_LANGS"
              :key="language.value"
              :value="language.value"
            >
              {{ language.label }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-button type="primary" html-type="submit" :loading="loading" block>
          {{ t("TXT_CODE_WORLD_ADMIN_CREATE") }}
        </a-button>
      </a-form>
    </div>
  </div>
</template>
<style scoped>
.initial-account {
  min-height: 85vh;
  display: grid;
  place-items: center;
  padding: 32px 16px;
}
.account-panel {
  background: var(--nc-dusk);
  border: var(--nc-hairline);
  border-radius: 12px;
  width: 100%;
  max-width: 430px;
  padding: 32px;
}
.wordmark {
  font: 600 23px var(--nc-font-display);
  color: var(--nc-parchment);
}
h1 {
  font-size: 16px;
  color: var(--nc-mist);
  font-weight: 400;
  margin: 14px 0 30px;
}
</style>
