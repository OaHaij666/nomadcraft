<script setup lang="ts">
import WorldArtwork from "@/widgets/worlds/WorldArtwork.vue";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { openInstanceTagsEditor, useDeleteInstanceDialog } from "@/components/fc/index";
import { useAppRouters } from "@/hooks/useAppRouters";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { useInstanceInfo, verifyEULA } from "@/hooks/useInstance";
import { t } from "@/lang/i18n";
import {
  killInstance,
  openInstance,
  restartInstance,
  stopInstance,
  updateInstance
} from "@/services/apis/instance";
import { arrayFilter } from "@/tools/array";
import { formatMemoryUsage } from "@/tools/memory";
import { parseTimestamp } from "@/tools/time";
import { reportErrorMsg } from "@/tools/validator";
import type { InstanceDetail, LayoutCard } from "@/types/index";
import {
  CloseOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  TagsOutlined,
  UserOutlined
} from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import _ from "lodash";
import { computed } from "vue";

const props = defineProps<{
  card: LayoutCard;
  targetInstanceInfo?: InstanceDetail;
  targetDaemonId?: string;
}>();

const emits = defineEmits(["refreshList"]);
const { isAdmin } = useAppStateStore();

const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const { toPage } = useAppRouters();
const instanceId = props.targetInstanceInfo?.instanceUuid || getMetaOrRouteValue("instanceId");
const daemonId = props.targetDaemonId || getMetaOrRouteValue("daemonId");

const { statusText, isRunning, isStopped, instanceTypeText, instanceInfo } = useInstanceInfo({
  instanceId: props.targetInstanceInfo ? undefined : instanceId,
  daemonId: props.targetInstanceInfo ? undefined : daemonId,
  autoRefresh: props.targetInstanceInfo ? false : true,
  instanceInfo: props.targetInstanceInfo ? computed(() => props.targetInstanceInfo) : undefined
});

const operationConfig = {
  params: {
    uuid: instanceId || "",
    daemonId: daemonId || ""
  }
};

const { isLoading: openLoading, execute: executeOpen } = openInstance();
const { isLoading: stopLoading, execute: executeStop } = stopInstance();
const { isLoading: restartLoading, execute: executeRestart } = restartInstance();
const { isLoading: killLoading, execute: executeKill } = killInstance();
const { isLoading: updateLoading, execute: executeUpdate } = updateInstance();

const refreshList = () => {
  setTimeout(() => {
    emits("refreshList");
  }, 500);
};

const actions = {
  start: async () => {
    const flag = await verifyEULA(instanceId ?? "", daemonId ?? "");
    if (!flag) return;
    await executeOpen(operationConfig);
    message.success(t("TXT_CODE_e13abbb1"));
  },
  stop: async () => {
    await executeStop(operationConfig);
    message.success(t("TXT_CODE_efb6d377"));
  },
  restart: async () => {
    await executeRestart(operationConfig);
    message.success(t("TXT_CODE_efb6d377"));
  },
  kill: async () => {
    await executeKill(operationConfig);
    message.success(t("TXT_CODE_efb6d377"));
  },
  update: async () => {
    await executeUpdate({
      params: {
        uuid: instanceId || "",
        daemonId: daemonId || "",
        task_name: "update"
      },
      data: {
        time: new Date().getTime()
      }
    });
    message.success(t("TXT_CODE_b1600db0"));
  }
};

const execInstanceAction = async (
  event: MouseEvent,
  actName: "start" | "stop" | "restart" | "kill" | "update"
) => {
  const action = actions[actName];
  try {
    if (action) {
      await action();
      refreshList();
    }
  } catch (error) {
    reportErrorMsg(error);
  }
};

const instanceOperations = computed(() =>
  arrayFilter([
    {
      title: t("TXT_CODE_57245e94"),
      icon: PlayCircleOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        await execInstanceAction(event, "start");
      },
      loading: openLoading.value,
      condition: () => isStopped.value
    },
    {
      title: t("TXT_CODE_b1dedda3"),
      icon: PauseCircleOutlined,
      click: (event: MouseEvent) => {
        event.stopPropagation();
        Modal.confirm({
          title: t("TXT_CODE_893567ac"),
          content: t("TXT_CODE_6da85509"),
          onOk: async () => {
            execInstanceAction(event, "stop");
          }
        });
        return false;
      },
      loading: stopLoading.value,
      condition: () => isRunning.value
    },
    {
      title: t("TXT_CODE_47dcfa5"),
      icon: RedoOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        Modal.confirm({
          title: t("TXT_CODE_893567ac"),
          content: t("TXT_CODE_f6bd907d"),
          onOk: async () => {
            execInstanceAction(event, "restart");
          }
        });
      },
      loading: restartLoading.value,
      condition: () => isRunning.value
    },
    {
      title: t("TXT_CODE_40ca4f2"),
      icon: CloudDownloadOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        execInstanceAction(event, "update");
      },
      loading: updateLoading.value,
      condition: () => isStopped.value
    },
    {
      title: t("TXT_CODE_7b67813a"),
      icon: CloseOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        Modal.confirm({
          title: t("TXT_CODE_893567ac"),
          content: t("TXT_CODE_ec08484"),
          onOk: async () => {
            execInstanceAction(event, "kill");
          }
        });
      },
      loading: killLoading.value,
      danger: true,
      condition: () => !isStopped.value
    },
    {
      area: true
    },
    {
      title: t("TXT_CODE_78e88c3f"),
      icon: TagsOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        if (instanceId && daemonId) {
          const tags = instanceInfo.value?.config.tag || [];
          const newTags = await openInstanceTagsEditor(instanceId, daemonId, tags);
          if (!_.isEqual(newTags, tags)) refreshList();
        }
      }
    },
    {
      title: t("TXT_CODE_524e3036"),
      icon: CodeOutlined,
      click: (event: MouseEvent) => {
        event.stopPropagation();
        toPage({
          path: "/instances/terminal",
          query: {
            daemonId,
            instanceId
          }
        });
      }
    },
    {
      title: t("TXT_CODE_a0e19f38"),
      condition: () => isAdmin.value,
      icon: DeleteOutlined,
      click: async (event: MouseEvent) => {
        event.stopPropagation();
        const deleteInstanceResult = await useDeleteInstanceDialog(
          instanceId || "",
          daemonId || ""
        );
        if (!deleteInstanceResult) return;
        message.success(t("TXT_CODE_f486dbb4"));
        refreshList();
      },
      danger: true
    }
  ])
);

const openWorld = () => toPage({ path: "/instances/terminal", query: { daemonId, instanceId } });
</script>

<template>
  <article class="world-card" :class="{ live: isRunning }">
    <WorldArtwork :seed="instanceId ?? ''" />
    <div class="world-card-content">
      <div class="world-card-top">
        <span class="world-status" :class="{ online: isRunning }"><i></i>{{ statusText }}</span><span class="world-type">{{ instanceTypeText }}</span>
      </div>
      <button class="world-title" type="button" @click="openWorld">
        {{ instanceInfo?.config.nickname || instanceId }}
      </button>
      <div class="world-tags">
        <a-tag v-for="tag in instanceInfo?.config.tag" :key="tag">{{ tag }}</a-tag>
      </div>
      <div class="world-metrics">
        <span v-if="instanceInfo?.info.mcPingOnline"><UserOutlined /> {{ instanceInfo.info.currentPlayers }} /
          {{ instanceInfo.info.maxPlayers }}</span>
        <span v-if="instanceInfo?.info.memoryUsage != null">{{
          formatMemoryUsage(instanceInfo.info.memoryUsage, instanceInfo.info.memoryLimit)
        }}</span>
        <span v-if="!isRunning">{{
          instanceInfo?.config.lastDatetime
            ? parseTimestamp(instanceInfo.config.lastDatetime)
            : t("TXT_CODE_WORLD_NEVER_STARTED")
        }}</span>
      </div>
      <div class="world-actions">
        <a-button class="enter-world" @click="openWorld">{{ t("TXT_CODE_WORLD_OPEN") }} →</a-button><a-space :size="4">
          <template v-for="item in instanceOperations" :key="item.title">
            <a-tooltip v-if="!item.area && item.icon !== CodeOutlined" :title="item.title">
              <a-button
                size="small"
                :aria-label="item.title"
                :loading="item.loading"
                :danger="item.danger"
                @click="item.click"
              >
                <component :is="item.icon" />
              </a-button>
            </a-tooltip>
          </template>
        </a-space>
      </div>
    </div>
  </article>
</template>

<style scoped>
.world-card {
  background: var(--nc-dusk);
  border: var(--nc-hairline);
  border-radius: 12px;
  overflow: hidden;
  height: 100%;
  text-align: left;
}
.world-card.live {
  border-color: var(--nc-aurora-dim);
}
.world-card-content {
  padding: 22px;
}
.world-card-top {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--nc-mist);
}
.world-status {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.world-status i {
  width: 6px;
  height: 6px;
  background: var(--nc-faint);
  border-radius: 50%;
}
.world-status.online {
  color: var(--nc-aurora);
}
.world-status.online i {
  background: var(--nc-aurora);
}
.world-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.world-title {
  border: 0;
  background: none;
  padding: 0;
  color: var(--nc-parchment);
  font: 600 21px var(--nc-font-display);
  text-align: left;
  margin: 15px 0 10px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.world-tags {
  min-height: 24px;
}
.world-tags :deep(.ant-tag) {
  font-size: 11px;
  margin-bottom: 4px;
}
.world-metrics {
  min-height: 26px;
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--nc-mist);
  margin: 16px 0 20px;
}
.world-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  border-top: var(--nc-hairline);
  padding-top: 16px;
}
.enter-world {
  border: 0;
  background: none;
  padding-left: 0;
  box-shadow: none;
  color: var(--nc-parchment);
}
.world-title:focus-visible {
  outline: 2px solid var(--nc-aurora);
  outline-offset: 4px;
}
</style>
