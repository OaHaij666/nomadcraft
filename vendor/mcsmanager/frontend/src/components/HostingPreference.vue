<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { t } from "@/lang/i18n";
import { getHostingPreference, setHostingPreference } from "@/services/apis/user";
import { useAppStateStore } from "@/stores/useAppStateStore";
import {
  DEFAULT_HOSTING_WILLINGNESS,
  HOSTING_WILLINGNESS,
  type HostingWillingness
} from "../../../shared/nomad-hosting-preference";
const { state } = useAppStateStore();
const { execute: fetchPreference } = getHostingPreference();
const { execute: savePreference } = setHostingPreference();
const value = ref<HostingWillingness>(DEFAULT_HOSTING_WILLINGNESS);
const saved = ref<HostingWillingness>();
const loading = ref(true),
  busy = ref(false),
  error = ref("");
const dirty = computed(() => saved.value !== undefined && value.value !== saved.value);
const load = async () => {
  loading.value = true;
  error.value = "";
  try {
    const result = (await fetchPreference({ forceRequest: true })).value;
    if (!result) throw new Error("empty response");
    value.value = result.hostingWillingness;
    saved.value = result.hostingWillingness;
  } catch {
    error.value = t("TXT_CODE_HOSTING_PREF_LOAD_ERROR");
  } finally {
    loading.value = false;
  }
};
const save = async () => {
  if (!dirty.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = (
      await savePreference({ data: { hostingWillingness: value.value }, forceRequest: true })
    ).value;
    if (!result) throw new Error("empty response");
    saved.value = result.hostingWillingness;
    value.value = result.hostingWillingness;
    if (state.userInfo) state.userInfo.hostingWillingness = result.hostingWillingness;
    message.success(t("TXT_CODE_HOSTING_PREF_SAVED"));
  } catch {
    error.value = t("TXT_CODE_HOSTING_PREF_SAVE_ERROR");
  } finally {
    busy.value = false;
  }
};
onMounted(load);
</script>
<template>
  <section class="hosting-preference">
    <h2>{{ t("TXT_CODE_HOSTING_PREF_TITLE") }}</h2>
    <p>{{ t("TXT_CODE_HOSTING_PREF_NOTE") }}</p>
    <a-alert v-if="error" class="preference-error" :message="error" type="error" show-icon />
    <a-radio-group
      v-model:value="value"
      :disabled="loading || busy || saved === undefined"
      button-style="solid"
      :aria-label="t('TXT_CODE_HOSTING_PREF_TITLE')"
    >
      <a-radio-button v-for="option in HOSTING_WILLINGNESS" :key="option" :value="option">
        {{
          t("TXT_CODE_HOSTING_PREF_" + option.toUpperCase())
        }}
      </a-radio-button>
    </a-radio-group>
    <p class="preference-description">
      {{ t("TXT_CODE_HOSTING_PREF_DESC_" + value.toUpperCase()) }}
    </p>
    <p class="preference-note">{{ t("TXT_CODE_HOSTING_PREF_PERMISSION_NOTE") }}</p>
    <a-space>
      <a-button type="primary" :loading="busy" :disabled="!dirty || loading" @click="save">
        {{
          t("TXT_CODE_HOSTING_PREF_SAVE")
        }}
      </a-button>
      <a-button v-if="saved === undefined && !loading" @click="load">
        {{
          t("TXT_CODE_HOSTING_PREF_RETRY")
        }}
      </a-button>
    </a-space>
  </section>
</template>
<style scoped>
.hosting-preference {
  max-width: 720px;
  color: var(--nc-parchment);
}
h2 {
  font-size: 18px;
  margin: 0 0 14px;
}
p {
  line-height: 1.8;
  font-size: 13px;
  color: var(--nc-mist);
}
.preference-description {
  margin-top: 16px;
}
.preference-note {
  margin-bottom: 20px;
}
.preference-error {
  margin-bottom: 16px;
}
</style>
