<script setup lang="ts">
import NetworkDiagnostics from "@/components/NetworkDiagnostics.vue";
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { t } from "@/lang/i18n";
import { computeApi, downloadText } from "@/services/apis/compute";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { ComputeNodeView, NetworkReport } from "../../../shared/nomad-compute";
const { isAdmin } = useAppStateStore();
const report = ref<NetworkReport>(),
  checking = ref(false);
const inspect = async () => {
  checking.value = true;
  try {
    report.value = await computeApi.serverCheck();
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    checking.value = false;
  }
};
const nodes = ref<ComputeNodeView[]>([]),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  showCreate = ref(false),
  newCommand = ref("");
const endpoint = new URL(window.location.href);
if (endpoint.hostname === "127.0.0.1" && endpoint.port === "5173") endpoint.port = "23333";
const form = ref({
  name: "",
  kind: "player",
  priority: 0,
  memoryBudgetMb: 4096,
  reserveMemoryMb: 1024,
  maxTasks: 1,
  allowAllInstances: true,
  allowedInstanceIds: [] as string[],
  panel: endpoint.origin
});
const load = async () => {
  if (loading.value || busy.value) return;
  loading.value = true;
  try {
    nodes.value = await computeApi.nodes();
    error.value = "";
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    loading.value = false;
  }
};
const add = async () => {
  busy.value = true;
  error.value = "";
  try {
    const address = new URL(form.value.panel);
    if (
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      (address.protocol !== "https:" &&
        !(
          address.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)
        ))
    )
      throw new Error("invalid panel address");
    const result = await computeApi.create({ ...form.value, panel: undefined });
    downloadText(
      "nomad-node-" + result.node.id + ".json",
      JSON.stringify({ ...result.credential, panel: form.value.panel }, null, 2)
    );
    newCommand.value =
      'nomad-agent panel-node --credential-file "nomad-node-' +
      result.node.id +
      '.json" --data-dir "nomad-node-data" --java "java"';
    showCreate.value = false;
    message.success(t("TXT_CODE_COMPUTE_PAIRED"));
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    busy.value = false;
    await load();
  }
};
const save = async (node: ComputeNodeView) => {
  busy.value = true;
  try {
    await computeApi.update(node.id, {
      name: node.name,
      enabled: node.enabled,
      ...(isAdmin.value ? { priority: node.priority } : {}),
      memoryBudgetMb: node.memoryBudgetMb,
      reserveMemoryMb: node.reserveMemoryMb,
      maxTasks: node.maxTasks,
      allowAllInstances: node.allowAllInstances,
      allowedInstanceIds: node.allowedInstanceIds
    });
    message.success(t("TXT_CODE_COMPUTE_SAVED"));
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    busy.value = false;
    await load();
  }
};
onMounted(load);
</script>
<template>
  <section class="compute-page">
    <div class="heading">
      <div>
        <h1>{{ t("TXT_CODE_COMPUTE_TITLE") }}</h1>
        <p>{{ t("TXT_CODE_COMPUTE_NOTE") }}</p>
      </div>
      <a-space>
        <a-button v-if="isAdmin" :loading="checking" @click="inspect">
          {{
            t("TXT_CODE_COMPUTE_SERVER_CHECK")
          }}
        </a-button><a-button :loading="loading" @click="load">{{ t("TXT_CODE_COMPUTE_REFRESH") }}</a-button><a-button type="primary" @click="showCreate = true">
          {{
            t("TXT_CODE_COMPUTE_ADD")
          }}
        </a-button>
      </a-space>
    </div>
    <a-alert v-if="error" :message="error" type="error" show-icon />
    <a-alert v-if="newCommand" class="command" type="success">
      <template #message>{{ t("TXT_CODE_COMPUTE_PAIR_NOTE") }}</template><template #description>
        <pre>{{ newCommand }}</pre>
        <p>{{ t("TXT_CODE_COMPUTE_COMMAND_NOTE") }}</p>
      </template>
    </a-alert>
    <NetworkDiagnostics v-if="report" :report="report" />
    <a-empty v-if="!loading && !nodes.length" :description="t('TXT_CODE_COMPUTE_EMPTY')" />
    <div class="node-grid">
      <article v-for="node in nodes" :key="node.id">
        <a-space>
          <h2>{{ node.name }}</h2>
          <a-tag :color="node.online ? 'green' : 'default'">
            {{
              t(node.online ? "TXT_CODE_COMPUTE_ONLINE" : "TXT_CODE_COMPUTE_OFFLINE")
            }}
          </a-tag><a-tag>{{ t("TXT_CODE_COMPUTE_" + node.kind.toUpperCase()) }}</a-tag>
        </a-space>
        <p>
          {{ node.ownerName }} · {{ t("TXT_CODE_COMPUTE_TASKS") }} {{ node.activeTasks }} /
          {{ node.maxTasks }}
        </p>
        <p v-if="node.metrics">
          {{ node.metrics.cpuCores }} CPU · {{ t("TXT_CODE_COMPUTE_AVAILABLE") }}
          {{ node.metrics.availableMemoryMb }} MiB
        </p>
        <a-form layout="vertical">
          <a-form-item :label="t('TXT_CODE_COMPUTE_ENABLED')">
            <a-switch v-model:checked="node.enabled" />
          </a-form-item><a-form-item v-if="isAdmin" :label="t('TXT_CODE_COMPUTE_PRIORITY')">
            <a-input-number v-model:value="node.priority" :min="-100" :max="100" />
          </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_BUDGET')">
            <a-input-number
              v-model:value="node.memoryBudgetMb"
              :min="512"
              :max="1048576"
              :step="512"
              addon-after="MiB"
            />
          </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_RESERVE')">
            <a-input-number
              v-model:value="node.reserveMemoryMb"
              :min="0"
              :max="1048576"
              :step="512"
              addon-after="MiB"
            />
          </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_MAX_TASKS')">
            <a-input-number v-model:value="node.maxTasks" :min="1" :max="16" />
          </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_ALL_INSTANCES')">
            <a-switch v-model:checked="node.allowAllInstances" />
          </a-form-item><a-form-item v-if="!node.allowAllInstances" :label="t('TXT_CODE_COMPUTE_INSTANCE_IDS')">
            <a-select v-model:value="node.allowedInstanceIds" mode="tags" />
          </a-form-item>
        </a-form>
        <p v-if="node.lastError" class="error">{{ node.lastError }}</p>
        <a-button type="primary" :loading="busy" @click="save(node)">
          {{
            t("TXT_CODE_COMPUTE_SAVE")
          }}
        </a-button>
      </article>
    </div>
    <a-modal
      v-model:open="showCreate"
      :title="t('TXT_CODE_COMPUTE_ADD')"
      :confirm-loading="busy"
      @ok="add"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('TXT_CODE_COMPUTE_NAME')">
          <a-input v-model:value="form.name" :maxlength="80" />
        </a-form-item><a-form-item v-if="isAdmin" :label="t('TXT_CODE_COMPUTE_KIND')">
          <a-select v-model:value="form.kind">
            <a-select-option value="server">{{ t("TXT_CODE_COMPUTE_SERVER") }}</a-select-option><a-select-option value="player">
              {{
                t("TXT_CODE_COMPUTE_PLAYER")
              }}
            </a-select-option>
          </a-select>
        </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_PANEL')">
          <a-input v-model:value="form.panel" />
        </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_BUDGET')">
          <a-input-number
            v-model:value="form.memoryBudgetMb"
            :min="512"
            :step="512"
            addon-after="MiB"
          />
        </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_RESERVE')">
          <a-input-number
            v-model:value="form.reserveMemoryMb"
            :min="0"
            :step="512"
            addon-after="MiB"
          />
        </a-form-item>
      </a-form>
      <p>{{ t("TXT_CODE_COMPUTE_PAIR_NOTE") }}</p>
    </a-modal>
  </section>
</template>
<style scoped>
.compute-page {
  max-width: 1440px;
  margin: 12px auto;
  color: var(--nc-parchment);
}
.heading {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
h1 {
  font-size: 28px;
  margin: 0 0 12px;
}
h2 {
  font-size: 18px;
  margin: 0;
}
p {
  color: var(--nc-mist);
  line-height: 1.8;
  font-size: 13px;
}
.node-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-top: 24px;
}
.node-grid article {
  border: var(--nc-hairline);
  background: var(--nc-dusk);
  border-radius: 12px;
  padding: 24px;
}
.command {
  margin: 20px 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.error {
  color: #e6a49a;
}
@media (max-width: 760px) {
  .node-grid {
    grid-template-columns: 1fr;
  }
}
</style>
