<script setup lang="ts">
import { router } from "@/config/router";
import { t } from "@/lang/i18n";
import { remoteInstances, remoteNodeList, userInfoApi } from "@/services/apis";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { InstanceDetail, LayoutCard, NodeStatus } from "@/types";
import type { UserInstance } from "@/types/user";
import { INSTANCE_STATUS, INSTANCE_STATUS_CODE } from "@/types/const";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref } from "vue";
import Shortcut from "@/widgets/instance/Shortcut.vue";
import WorldArtwork from "./WorldArtwork.vue";

const props = defineProps<{ card: LayoutCard }>();
const { isAdmin } = useAppStateStore();
interface Group {
  node: NodeStatus;
  worlds: InstanceDetail[];
  page: number;
  maxPage: number;
  loading: boolean;
  error: string;
}
const groups = ref<Group[]>([]);
const assigned = ref<UserInstance[]>([]);
const search = ref("");
const status = ref("");
const node = ref("");
const loading = ref(false);
const loadError = ref("");
const visibleGroups = computed(() =>
  groups.value.filter((g) => !node.value || g.node.uuid === node.value)
);
const visibleAssigned = computed(() =>
  assigned.value.filter(
    (w) =>
      (!search.value.trim() ||
        w.nickname.toLowerCase().includes(search.value.trim().toLowerCase())) &&
      (!status.value || String(w.status) === status.value)
  )
);
const count = computed(() =>
  isAdmin.value
    ? visibleGroups.value.reduce((sum, g) => sum + g.worlds.length, 0)
    : visibleAssigned.value.length
);
const running = computed(() =>
  isAdmin.value
    ? visibleGroups.value
        .flatMap((g) => g.worlds)
        .filter((w) => w.status === INSTANCE_STATUS_CODE.RUNNING).length
    : visibleAssigned.value.filter((w) => w.status === INSTANCE_STATUS_CODE.RUNNING).length
);
const loadGroup = async (group: Group, nextPage = 1) => {
  if (group.loading) return;
  group.loading = true;
  group.error = "";
  try {
    const result = await remoteInstances().execute({
      params: {
        daemonId: group.node.uuid,
        page: nextPage,
        page_size: 20,
        instance_name: search.value.trim(),
        status: status.value
      }
    });
    if (!result.value) throw new Error(t("TXT_CODE_WORLD_LOAD_ERROR"));
    const fresh = result.value.data ?? [];
    group.worlds =
      nextPage === 1
        ? fresh
        : [...new Map([...group.worlds, ...fresh].map((w) => [w.instanceUuid, w])).values()];
    group.page = result.value.page;
    group.maxPage = result.value.maxPage;
  } catch (error) {
    group.error = String(error instanceof Error ? error.message : error);
  } finally {
    group.loading = false;
  }
};
const refresh = async () => {
  if (loading.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    if (isAdmin.value) {
      const result = await remoteNodeList().execute();
      groups.value = (result.value ?? []).map((host) => ({
        node: host,
        worlds: [],
        page: 1,
        maxPage: 1,
        loading: false,
        error: ""
      }));
      await Promise.allSettled(groups.value.map((g) => loadGroup(g)));
    } else {
      const result = await userInfoApi().execute({ params: { advanced: true } });
      assigned.value = result.value?.instances ?? [];
    }
  } catch (error) {
    loadError.value = String(error instanceof Error ? error.message : error);
  } finally {
    loading.value = false;
  }
};
const openAssigned = (world: UserInstance) =>
  router.push({
    path: "/instances/terminal",
    query: { daemonId: world.daemonId, instanceId: world.instanceUuid }
  });
onMounted(refresh);
</script>

<template>
  <div class="worlds-page">
    <header class="worlds-header">
      <div>
        <span class="eyebrow">NOMADCRAFT / WORLDS</span>
        <h1>{{ t("TXT_CODE_WORLD_LIST") }}</h1>
        <p>{{ t("TXT_CODE_WORLD_LIST_NOTE") }}</p>
      </div>
      <a-button v-if="isAdmin" type="primary" @click="router.push('/worlds/new')">
        <PlusOutlined /> {{ t("TXT_CODE_WORLD_CREATE") }}
      </a-button>
    </header>
    <div class="worlds-toolbar">
      <div class="worlds-filters">
        <a-input-search
          v-model:value="search"
          class="world-search"
          :placeholder="t('TXT_CODE_WORLD_SEARCH')"
          :aria-label="t('TXT_CODE_WORLD_SEARCH')"
          allow-clear
          @search="refresh"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input-search>
        <a-select v-model:value="status" :aria-label="t('TXT_CODE_WORLD_STATUS')" @change="refresh">
          <a-select-option value="">{{ t("TXT_CODE_WORLD_ALL_STATUS") }}</a-select-option><a-select-option
            v-for="(label, code) in INSTANCE_STATUS"
            :key="code"
            :value="String(code)"
          >
            {{ label }}
          </a-select-option>
        </a-select>
        <a-select
          v-if="isAdmin && groups.length > 1"
          v-model:value="node"
          :aria-label="t('TXT_CODE_WORLD_HOSTS')"
        >
          <a-select-option value="">{{ t("TXT_CODE_WORLD_ALL_HOSTS") }}</a-select-option><a-select-option
            v-for="group in groups"
            :key="group.node.uuid"
            :value="group.node.uuid"
          >
            {{ group.node.remarks || group.node.ip }}
          </a-select-option>
        </a-select>
      </div>
      <a-button :loading="loading" :aria-label="t('TXT_CODE_b76d94e0')" @click="refresh">
        <ReloadOutlined />
      </a-button>
    </div>
    <div class="worlds-summary">
      <span>{{ t("TXT_CODE_WORLD_LOADED", { count }) }}</span><span><i></i>{{ t("TXT_CODE_WORLD_RUNNING", { count: running }) }}</span><span class="game-label">Minecraft: Java Edition</span>
    </div>
    <a-alert v-if="loadError" type="error" :message="loadError" class="mb-20" />
    <Loading v-if="loading" />
    <template v-else-if="isAdmin">
      <section v-for="group in visibleGroups" :key="group.node.uuid" class="host-group">
        <div v-if="groups.length > 1 || group.error" class="host-label">
          <span>{{ group.node.remarks || group.node.ip }}</span><small v-if="!group.node.available">{{ t("TXT_CODE_WORLD_HOST_OFFLINE") }}</small>
        </div>
        <a-alert
          v-if="group.error"
          type="warning"
          :message="t('TXT_CODE_WORLD_HOST_UNAVAILABLE')"
          :description="group.error"
          show-icon
        >
          <template #action>
            <a-button size="small" :loading="group.loading" @click="loadGroup(group)">
              {{
                t("TXT_CODE_b76d94e0")
              }}
            </a-button>
          </template>
        </a-alert>
        <div class="world-grid">
          <Shortcut
            v-for="world in group.worlds"
            :key="world.instanceUuid"
            :card="props.card"
            :target-instance-info="world"
            :target-daemon-id="group.node.uuid"
            @refresh-list="loadGroup(group)"
          />
        </div>
        <div v-if="group.page < group.maxPage" class="load-more">
          <a-button :loading="group.loading" @click="loadGroup(group, group.page + 1)">
            {{
              t("TXT_CODE_101ef36f")
            }}
          </a-button>
        </div>
      </section>
      <div
        v-if="count === 0 && !loadError && visibleGroups.every((g) => !g.error)"
        class="worlds-empty"
      >
        <span class="empty-mark" aria-hidden="true">◇</span>
        <h2>{{ t(search || status ? "TXT_CODE_WORLD_NO_MATCH" : "TXT_CODE_WORLD_EMPTY") }}</h2>
        <a-button v-if="!search && !status" type="primary" @click="router.push('/worlds/new')">
          <PlusOutlined /> {{ t("TXT_CODE_WORLD_CREATE") }}
        </a-button>
      </div>
    </template>
    <template v-else>
      <div class="world-grid">
        <article
          v-for="world in visibleAssigned"
          :key="world.daemonId + world.instanceUuid"
          class="assigned-world"
        >
          <WorldArtwork :seed="world.instanceUuid" />
          <div class="assigned-content">
            <span class="assigned-status">{{
              INSTANCE_STATUS[world.status as INSTANCE_STATUS_CODE] ?? "—"
            }}</span>
            <h2>{{ world.nickname }}</h2>
            <a-button
              :disabled="world.status === INSTANCE_STATUS_CODE.BUSY"
              @click="openAssigned(world)"
            >
              {{ t("TXT_CODE_WORLD_OPEN") }} →
            </a-button>
          </div>
        </article>
      </div>
      <div v-if="count === 0 && !loadError" class="worlds-empty">
        <h2>
          {{ t(search || status ? "TXT_CODE_WORLD_NO_MATCH" : "TXT_CODE_WORLD_NONE_ASSIGNED") }}
        </h2>
      </div>
    </template>
  </div>
</template>

<style scoped>
.worlds-page {
  max-width: 1460px;
  margin: 14px auto 0;
  color: var(--nc-parchment);
}
.worlds-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 34px;
}
.eyebrow {
  color: var(--nc-mist);
  font: 11px var(--nc-font-mono);
  letter-spacing: 0.16em;
}
h1 {
  font: 600 36px var(--nc-font-display);
  margin: 12px 0 10px;
}
.worlds-header p {
  color: var(--nc-mist);
  font-size: 14px;
  margin: 0;
}
.worlds-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 18px;
}
.worlds-filters {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.world-search {
  width: 280px;
}
.worlds-filters :deep(.ant-select) {
  min-width: 140px;
}
.worlds-summary {
  display: flex;
  align-items: center;
  gap: 22px;
  border-bottom: var(--nc-hairline);
  padding-bottom: 20px;
  margin-bottom: 28px;
  color: var(--nc-mist);
  font-size: 12px;
}
.worlds-summary i {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--nc-aurora);
  border-radius: 50%;
  margin-right: 6px;
}
.game-label {
  margin-left: auto;
  font-family: var(--nc-font-mono);
}
.world-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 22px;
}
.host-group {
  margin-bottom: 24px;
}
.host-label {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--nc-mist);
  margin-bottom: 14px;
  font-size: 12px;
}
.host-label small {
  color: var(--nc-ember);
}
.load-more {
  text-align: center;
  margin-top: 22px;
}
.worlds-empty {
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  border: 1px dashed var(--nc-veil);
  border-radius: 12px;
  color: var(--nc-mist);
}
.worlds-empty h2 {
  font-size: 16px;
  font-weight: 400;
}
.empty-mark {
  font-size: 42px;
  color: var(--nc-faint);
}
.assigned-world {
  border: var(--nc-hairline);
  border-radius: 12px;
  overflow: hidden;
  background: var(--nc-dusk);
}
.assigned-content {
  padding: 22px;
}
.assigned-status {
  font-size: 12px;
  color: var(--nc-mist);
}
.assigned-content h2 {
  font: 600 21px var(--nc-font-display);
  margin: 12px 0 24px;
}
@media (min-width: 1700px) {
  .world-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  .world-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 650px) {
  .world-grid {
    grid-template-columns: 1fr;
  }
  .worlds-header {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .world-search {
    width: 100%;
  }
  .worlds-filters {
    flex: 1;
  }
  .worlds-filters :deep(.ant-select) {
    flex: 1;
  }
  .game-label {
    display: none;
  }
  h1 {
    font-size: 28px;
  }
}
</style>
