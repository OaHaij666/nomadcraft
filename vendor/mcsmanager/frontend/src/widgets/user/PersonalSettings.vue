<script setup lang="ts">
import HostingPreference from "@/components/HostingPreference.vue";
import { t } from "@/lang/i18n";
</script>
<template>
  <div class="personal-settings">
    <p class="eyebrow">{{ t("TXT_CODE_HOSTING_PREF_PERSONAL") }}</p>
    <HostingPreference />
  </div>
</template>
<style scoped>
.personal-settings {
  max-width: 1000px;
  margin: 12px auto;
  padding: 28px;
  border: var(--nc-hairline);
  background: var(--nc-dusk);
  border-radius: 12px;
}
.eyebrow {
  font-size: 12px;
  color: var(--nc-mist);
  margin: 0 0 24px;
}
</style>
