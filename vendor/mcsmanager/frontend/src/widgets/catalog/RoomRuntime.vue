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
const useGateway=ref(props.save.gateway?.enabled??false),backendPort=ref(props.save.gateway?.backendPort??25566),gatewayDirty=ref(false);
const requestError=(reason:unknown)=>{
 const text=reason instanceof Error?reason.message:JSON.stringify(reason);
 const labels:Record<string,string>={gateway_ingress_required:"请先配置固定网络入口，再开启不断线网关。",gateway_port_conflict:"内部端口不能与网关监听端口相同。",network_port_reserved:"端口已被其他房间使用，请换一个空闲端口。",gateway_loader_unsupported:"当前网关支持 1.20.1 原版／Fabric／Forge 和 1.21.1 原版／Fabric／NeoForge。",close_rooms_first:"请先关闭房间并等待存档保存完成。",host_must_stop_first:"旧主机正在保存，请等待托管任务结束后再修改。",forbidden:"只有管理员可以修改网络和网关配置。"};
 for(const [key,label]of Object.entries(labels))if(text?.includes(key))return label;
 return t("TXT_CODE_COMPUTE_REQUEST_FAILED");
};
const persist = async () => {
  busy.value = true;
  error.value="";
  try {
    await computeApi.runtime(props.instanceId, props.save.id, {
      placement: placement.value,
      ...(isAdmin.value ? { ingress: useIngress.value ? ingress.value : null, ...((props.save.gateway!==undefined||gatewayDirty.value)?{gateway:{enabled:useIngress.value&&useGateway.value,backendPort:backendPort.value}}:{}) } : {})
    });
    message.success(t("TXT_CODE_COMPUTE_SAVED"));
    emit("done");
  } catch (reason) {
    error.value = requestError(reason);
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
          <p>{{ useGateway ? "固定入口由网关监听。公网端口可与监听端口不同；已有穿透软件应映射到网关监听端口。" : t("TXT_CODE_COMPUTE_INGRESS_NOTE") }}</p>
          <section class="gateway-settings">
            <a-form-item label="主机交接不断线">
              <a-switch v-model:checked="useGateway" :disabled="save.room?.desiredState==='open'" @change="gatewayDirty=true" />
            </a-form-item>
            <p>交接时保留玩家连接，在等待画面等待存档保存和新主机启动，随后自动返回房间。</p>
            <template v-if="useGateway">
              <a-form-item label="内部中转端口（仅监听服务器本机）">
                <a-input-number v-model:value="backendPort" :min="1" :max="65535" :disabled="save.room?.desiredState==='open'" @change="gatewayDirty=true" />
              </a-form-item>
              <small>玩家使用上面的公开地址和端口。内部端口需空闲，且不能与网关监听端口相同。网关在云端运行，需要 Java 21。</small>
            </template>
          </section>

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
.gateway-settings { padding: 18px; margin: 16px 0; border: var(--nc-hairline); border-radius: 12px; background: var(--nc-glass-soft, rgba(255,255,255,0.025)); }
.gateway-settings p { margin: 0 0 14px; }
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
