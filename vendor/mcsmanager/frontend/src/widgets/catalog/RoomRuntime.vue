<script setup lang="ts">
import NetworkDiagnostics from "@/components/NetworkDiagnostics.vue";
import { onMounted, ref } from "vue";
import { t } from "@/lang/i18n";
import { message } from "ant-design-vue";
import { computeApi, downloadText } from "@/services/apis/compute";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { CatalogSave } from "../../../../shared/nomad-catalog";
import {
  DEFAULT_PLACEMENT,
  type PlacementPolicy,
  type NetworkIngress,
  type ComputeNodeView,
  type NetworkReport
} from "../../../../shared/nomad-compute";
const props = defineProps<{ instanceId: string; save: CatalogSave }>();
// eslint-disable-next-line no-unused-vars
const emit = defineEmits<{ (e: "done"): void }>();
const { isAdmin } = useAppStateStore();
const placement = ref<PlacementPolicy>({ ...(props.save.placement ?? DEFAULT_PLACEMENT) });
const ingress = ref<NetworkIngress>({
  ...(props.save.ingress ?? {
    kind: "direct",
    bindHost: "127.0.0.1",
    bindPort: 25565,
    publicHost: "127.0.0.1",
    publicPort: 25565,
    family: "auto",
    tunnelHost: "",
    tunnelPort: 7000
  })
});
const useIngress = ref(!!props.save.ingress),
  nodes = ref<ComputeNodeView[]>([]),
  busy = ref(false),
  checking = ref(false),
  error = ref(""),
  report = ref<NetworkReport>(),
  config = ref("");
const persist = async () => {
  busy.value = true;
  try {
    await computeApi.runtime(props.instanceId, props.save.id, {
      placement: placement.value,
      ...(isAdmin.value ? { ingress: useIngress.value ? ingress.value : null } : {})
    });
    message.success(t("TXT_CODE_COMPUTE_SAVED"));
    emit("done");
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    busy.value = false;
  }
};
const check = async () => {
  checking.value = true;
  error.value = "";
  try {
    report.value = await computeApi.check(props.instanceId, props.save.id);
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  } finally {
    checking.value = false;
  }
};
const frp = async () => {
  try {
    config.value = await computeApi.frp(props.instanceId, props.save.id);
    downloadText("nomad-frpc.toml", config.value);
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  }
};
onMounted(async () => {
  try {
    nodes.value = await computeApi.nodes(props.instanceId);
  } catch {
    error.value = t("TXT_CODE_COMPUTE_REQUEST_FAILED");
  }
});
</script>
<template>
  <div class="room-runtime">
    <a-alert v-if="error" :message="error" type="error" show-icon /><a-form layout="vertical">
      <a-form-item :label="t('TXT_CODE_COMPUTE_POLICY')">
        <a-select v-model:value="placement.mode" :disabled="save.room?.desiredState === 'open'">
          <a-select-option
            v-for="mode in ['manual', 'fixed', 'auto', 'fallback']"
            :key="mode"
            :value="mode"
          >
            {{ t("TXT_CODE_COMPUTE_MODE_" + mode.toUpperCase()) }}
          </a-select-option>
        </a-select>
      </a-form-item><a-form-item
        v-if="['fixed', 'fallback'].includes(placement.mode)"
        :label="t('TXT_CODE_COMPUTE_SELECTED_NODE')"
      >
        <a-select
          :value="placement.nodeId ?? undefined"
          :disabled="save.room?.desiredState === 'open'"
          allow-clear
          @change="(value) => (placement.nodeId = value ? String(value) : null)"
        >
          <a-select-option
            v-for="node in nodes.filter(
              (n) => placement.mode !== 'fallback' || n.kind === 'server'
            )"
            :key="node.id"
            :value="node.id"
          >
            {{ node.name }} ·
            {{
              t(node.online ? "TXT_CODE_COMPUTE_ONLINE" : "TXT_CODE_COMPUTE_OFFLINE")
            }}
          </a-select-option>
        </a-select>
      </a-form-item>
      <p>{{ t("TXT_CODE_COMPUTE_POLICY_NOTE") }}</p>
      <template v-if="isAdmin">
        <a-divider /><a-form-item :label="t('TXT_CODE_COMPUTE_INGRESS_ENABLED')">
          <a-switch
            v-model:checked="useIngress"
            :disabled="save.room?.desiredState === 'open'"
          />
        </a-form-item><template v-if="useIngress">
          <a-form-item :label="t('TXT_CODE_COMPUTE_INGRESS_KIND')">
            <a-select v-model:value="ingress.kind" :disabled="save.room?.desiredState === 'open'">
              <a-select-option
                v-for="kind in [
                  'direct',
                  'generic-tcp',
                  'frp',
                  'private-network',
                  'client-assisted'
                ]"
                :key="kind"
                :value="kind"
              >
                {{
                  t("TXT_CODE_COMPUTE_INGRESS_" + kind.toUpperCase().replace(/-/g, "_"))
                }}
              </a-select-option>
            </a-select>
          </a-form-item>
          <div class="endpoint-grid">
            <a-form-item :label="t('TXT_CODE_COMPUTE_BIND_HOST')">
              <a-input
                v-model:value="ingress.bindHost"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_BIND_PORT')">
              <a-input-number
                v-model:value="ingress.bindPort"
                :min="1"
                :max="65535"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_PUBLIC_HOST')">
              <a-input
                v-model:value="ingress.publicHost"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_PUBLIC_PORT')">
              <a-input-number
                v-model:value="ingress.publicPort"
                :min="1"
                :max="65535"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item>
          </div>
          <a-form-item :label="t('TXT_CODE_COMPUTE_FAMILY')">
            <a-select v-model:value="ingress.family" :disabled="save.room?.desiredState === 'open'">
              <a-select-option value="auto">
                {{
                  t("TXT_CODE_COMPUTE_FAMILY_AUTO")
                }}
              </a-select-option><a-select-option value="ipv4">IPv4</a-select-option><a-select-option value="ipv6">IPv6</a-select-option>
            </a-select>
          </a-form-item><template v-if="ingress.kind === 'frp'">
            <a-form-item :label="t('TXT_CODE_COMPUTE_TUNNEL_HOST')">
              <a-input
                v-model:value="ingress.tunnelHost"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item><a-form-item :label="t('TXT_CODE_COMPUTE_TUNNEL_PORT')">
              <a-input-number
                v-model:value="ingress.tunnelPort"
                :min="1"
                :max="65535"
                :disabled="save.room?.desiredState === 'open'"
              />
            </a-form-item>
          </template>
          <p>{{ t("TXT_CODE_COMPUTE_INGRESS_NOTE") }}</p>
        </template>
      </template>
    </a-form><a-space wrap>
      <a-button
        type="primary"
        :loading="busy"
        :disabled="save.room?.desiredState === 'open'"
        @click="persist"
      >
        {{ t("TXT_CODE_COMPUTE_SAVE") }}
      </a-button><a-button v-if="isAdmin" :loading="checking" @click="check">
        {{
          t("TXT_CODE_COMPUTE_CHECK")
        }}
      </a-button><a-button v-if="isAdmin && props.save.ingress?.kind === 'frp'" @click="frp">
        {{
          t("TXT_CODE_COMPUTE_EXPORT_FRP")
        }}
      </a-button>
    </a-space>
    <p v-if="save.room?.desiredState === 'open'">{{ t("TXT_CODE_COMPUTE_CLOSE_FIRST") }}</p>
    <NetworkDiagnostics v-if="report" :report="report" />
  </div>
</template>
<style scoped>
.endpoint-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}
.room-runtime p {
  font-size: 13px;
  line-height: 1.8;
  color: var(--nc-mist);
}
.network-report {
  margin-top: 24px;
}
.check-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 0;
  border-bottom: var(--nc-hairline);
}
small {
  display: block;
  overflow-wrap: anywhere;
  color: var(--nc-mist);
  margin-top: 5px;
}
@media (max-width: 550px) {
  .endpoint-grid {
    grid-template-columns: 1fr;
  }
}
</style>
