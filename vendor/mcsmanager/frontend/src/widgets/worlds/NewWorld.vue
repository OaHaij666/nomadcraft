<script setup lang="ts">
import { openNodeSelectDialog } from "@/components/fc";
import { router } from "@/config/router";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import { WORLD_SOURCE } from "@/types/world";
import {
  FileZipOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ArrowLeftOutlined
} from "@ant-design/icons-vue";
import { ref } from "vue";
import CreateWorldForm from "./CreateWorldForm.vue";

const props = defineProps<{ card: LayoutCard }>();
const { isAdmin } = useAppStateStore();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const daemonId = ref(getMetaOrRouteValue("daemonId", false) ?? "");
const source = ref(WORLD_SOURCE.FILE);
const showForm = ref(false);
const selectingNode = ref(false);
const sources = [
  {
    value: WORLD_SOURCE.FILE,
    title: "TXT_CODE_WORLD_FROM_JAR",
    note: "TXT_CODE_WORLD_FROM_JAR_NOTE",
    icon: PlusOutlined
  },
  {
    value: WORLD_SOURCE.IMPORT,
    title: "TXT_CODE_WORLD_FROM_ARCHIVE",
    note: "TXT_CODE_WORLD_FROM_ARCHIVE_NOTE",
    icon: FileZipOutlined
  },
  {
    value: WORLD_SOURCE.EXIST,
    title: "TXT_CODE_WORLD_FROM_DIRECTORY",
    note: "TXT_CODE_WORLD_FROM_DIRECTORY_NOTE",
    icon: FolderOpenOutlined
  }
];
const create = async (value: WORLD_SOURCE) => {
  if (!isAdmin.value || selectingNode.value) return;
  selectingNode.value = true;
  try {
    const node = await openNodeSelectDialog();
    if (!node) return;
    daemonId.value = node.uuid;
    source.value = value;
    showForm.value = true;
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    selectingNode.value = false;
  }
};
const created = (instanceId: string) => {
  showForm.value = false;
  router.push({ path: "/instances/terminal", query: { instanceId, daemonId: daemonId.value } });
};
</script>

<template>
  <div class="new-world">
    <a-button type="text" class="back" @click="router.push('/instances')">
      <ArrowLeftOutlined /> {{ t("TXT_CODE_WORLD_LIST") }}
    </a-button>
    <header>
      <span class="eyebrow">NOMADCRAFT / WORLDS</span>
      <h1>{{ t("TXT_CODE_WORLD_CREATE") }}</h1>
    </header>
    <section class="game-section" :aria-label="t('TXT_CODE_WORLD_GAME')">
      <h2>{{ t("TXT_CODE_WORLD_GAME") }}</h2>
      <button type="button" class="game-choice" aria-pressed="true">
        <span class="game-icon" aria-hidden="true">MC</span><span><strong>Minecraft: Java Edition</strong><small>{{ t("TXT_CODE_WORLD_GAME_NOTE") }}</small></span><span class="selected-mark" aria-hidden="true">✓</span>
      </button>
    </section>
    <section v-if="isAdmin">
      <h2>{{ t("TXT_CODE_WORLD_SOURCE") }}</h2>
      <div class="source-grid">
        <button
          v-for="item in sources"
          :key="item.value"
          type="button"
          class="source-choice"
          :disabled="selectingNode"
          @click="create(item.value)"
        >
          <component :is="item.icon" /><strong>{{ t(item.title) }}</strong><small>{{ t(item.note) }}</small>
        </button>
      </div>
    </section>
    <a-modal
      v-model:open="showForm"
      :title="t('TXT_CODE_WORLD_CREATE')"
      :width="680"
      :footer="null"
      destroy-on-close
    >
      <CreateWorldForm :create-method="source" :daemon-id="daemonId" @next-step="created" />
    </a-modal>
  </div>
</template>

<style scoped>
.new-world {
  max-width: 980px;
  margin: 16px auto;
  color: var(--nc-parchment);
}
.back {
  margin: 0 0 24px -12px;
}
.eyebrow {
  color: var(--nc-mist);
  font: 11px var(--nc-font-mono);
  letter-spacing: 0.16em;
}
h1 {
  font: 600 34px var(--nc-font-display);
  margin: 12px 0 36px;
}
h2 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 16px;
  color: var(--nc-mist);
}
.game-section {
  margin-bottom: 36px;
}
.game-choice {
  display: flex;
  align-items: center;
  gap: 18px;
  width: 100%;
  padding: 24px;
  border: 1px solid var(--nc-aurora-dim);
  border-radius: 12px;
  background: var(--nc-dusk);
  color: inherit;
  text-align: left;
}
.game-icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  background: var(--nc-haze);
  font: 600 18px var(--nc-font-mono);
  border-radius: 8px;
  color: var(--nc-aurora);
}
.game-choice strong,
.game-choice small {
  display: block;
}
small {
  font-size: 13px;
  color: var(--nc-mist);
  line-height: 1.7;
  margin-top: 6px;
}
.selected-mark {
  margin-left: auto;
  color: var(--nc-aurora);
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.source-choice {
  color: inherit;
  background: var(--nc-dusk);
  border: var(--nc-hairline);
  border-radius: 12px;
  text-align: left;
  padding: 24px;
  cursor: pointer;
}
.source-choice > .anticon {
  font-size: 22px;
  margin-bottom: 28px;
  color: var(--nc-mist);
}
.source-choice strong,
.source-choice small {
  display: block;
}
.source-choice:hover {
  border-color: var(--nc-aurora-dim);
}
button:focus-visible {
  outline: 2px solid var(--nc-aurora);
  outline-offset: 4px;
}
@media (max-width: 650px) {
  .source-grid {
    grid-template-columns: 1fr;
  }
  .source-choice > .anticon {
    margin-bottom: 16px;
  }
  h1 {
    font-size: 28px;
  }
}
</style>
