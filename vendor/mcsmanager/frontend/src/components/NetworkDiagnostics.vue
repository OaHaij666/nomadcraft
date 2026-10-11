<script setup lang="ts">
import { t } from "@/lang/i18n";
import type { NetworkReport } from "../../../shared/nomad-compute";
defineProps<{ report: NetworkReport }>();
</script>
<template>
  <section class="network-report">
    <h3>{{ t("TXT_CODE_COMPUTE_CHECK_TITLE") }}</h3>
    <a-alert :message="t('TXT_CODE_COMPUTE_EXTERNAL_NOTE')" type="warning" show-icon />
    <div v-for="(item, index) in report.checks" :key="index" class="check-row">
      <a-tag :color="item.status === 'ok' ? 'green' : item.status === 'failed' ? 'red' : 'gold'">
        {{
          t("TXT_CODE_COMPUTE_CHECK_" + item.status.toUpperCase())
        }}
      </a-tag>
      <div>
        {{ t("TXT_CODE_COMPUTE_NETWORK_" + item.message.toUpperCase())
        }}<small v-if="item.address || item.family">{{ item.address ?? "" }} · {{ item.family === 6 ? "IPv6" : "IPv4"
        }}<span v-if="item.latencyMs !== undefined"> · {{ item.latencyMs }} ms</span><span v-if="item.version"> · {{ item.version }}</span></small>
      </div>
    </div>
  </section>
</template>
<style scoped>
.network-report {
  margin: 24px 0;
}
.check-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 0;
  border-bottom: var(--nc-hairline);
}
.check-row > div {
  min-width: 0;
}
small {
  display: block;
  overflow-wrap: anywhere;
  color: var(--nc-mist);
  margin-top: 5px;
}
</style>
