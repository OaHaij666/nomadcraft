<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { router } from "@/config/router";
import { ct, useCatalog } from "@/hooks/useCatalog";
import {
  catalogApi,
  type CatalogUser,
  type InstanceInput,
  type InstanceView
} from "@/services/apis/catalog";
import { useAppStateStore } from "@/stores/useAppStateStore";
import {
  AppstoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ArrowRightOutlined,
  FolderOutlined
} from "@ant-design/icons-vue";
import InstanceEditor from "./InstanceEditor.vue";
import CloudImport from "./CloudImport.vue";
import WorldArtwork from "@/widgets/worlds/WorldArtwork.vue";
const { data, loading, error, busy, reload, mutate } = useCatalog();
const { isAdmin } = useAppStateStore();
const search = ref("");
const loader = ref("");
const showCreate = ref(false);
const showCreators = ref(false);
const users = ref<CatalogUser[]>([]);
const creatorIds = ref<string[]>([]);
const instances = computed(() =>
  data.value.instances.filter(
    (i) =>
      (!loader.value || i.profile.loader === loader.value) &&
      [i.name, i.profile.mcVersion, i.profile.packName, i.profile.loader]
        .join(" ")
        .toLowerCase()
        .includes(search.value.trim().toLowerCase())
  )
);
const saveCount = computed(() => data.value.instances.reduce((sum, i) => sum + i.saves.length, 0));
const roomCount = computed(() =>
  data.value.instances.reduce((sum, i) => sum + i.saves.filter((s) => s.room).length, 0)
);
const open = (instance: InstanceView) =>
  router.push({ path: "/catalog/detail", query: { id: instance.id } });
const imported = async (id: string) => { showCreate.value = false; await reload(); router.push({path: "/catalog/detail", query: {id}}); };
const create = async (input: InstanceInput) => {
  let id = "";
  if (
    await mutate(async () => {
      id = (await catalogApi.create(input)).id;
    })
  ) {
    showCreate.value = false;
    router.push({ path: "/catalog/detail", query: { id } });
  }
};
const editCreators = async () => {
  if (
    await mutate(async () => {
      users.value = await catalogApi.users();
      creatorIds.value = [...(data.value.creatorIds ?? [])];
    })
  )
    showCreators.value = true;
};
const saveCreators = async () => {
  if (await mutate(() => catalogApi.creators(creatorIds.value))) showCreators.value = false;
};
onMounted(reload);
</script>
<template>
  <div class="catalog-page">
    <header class="catalog-heading">
      <div>
        <span class="catalog-eyebrow">NOMADCRAFT / INSTANCE CENTER</span>
        <h1>{{ ct("CENTER") }}</h1>
        <p>{{ ct("CENTER_NOTE") }}</p>
      </div>
      <a-space
        ><a-button v-if="isAdmin" @click="editCreators"
          ><SafetyCertificateOutlined /> {{ ct("CREATE_PERMISSIONS") }}</a-button
        ><a-button v-if="data.canCreate" type="primary" @click="showCreate = true"
          ><PlusOutlined /> {{ ct("NEW_INSTANCE") }}</a-button
        ></a-space
      >
    </header>
    <div class="catalog-stats">
      <div>
        <AppstoreOutlined /><strong>{{ data.instances.length }}</strong
        ><span>{{ ct("LOGICAL_INSTANCES") }}</span>
      </div>
      <div>
        <FolderOutlined /><strong>{{ saveCount }}</strong
        ><span>{{ ct("SAVES") }}</span>
      </div>
      <div>
        <span class="stat-dot"></span><strong>{{ roomCount }}</strong
        ><span>{{ ct("ROOMS") }}</span>
      </div>
      <span class="catalog-rule">{{ ct("HIERARCHY_NOTE") }}</span>
    </div>
    <div class="catalog-toolbar">
      <a-input-search
        v-model:value="search"
        :placeholder="ct('SEARCH')"
        :aria-label="ct('SEARCH')"
        allow-clear
      /><a-select v-model:value="loader" :aria-label="ct('LOADER')"
        ><a-select-option value="">{{ ct("ALL_LOADERS") }}</a-select-option
        ><a-select-option
          v-for="item in ['vanilla', 'paper', 'fabric', 'forge', 'neoforge']"
          :key="item"
          :value="item"
          >{{ item === "vanilla" ? ct("VANILLA") : item }}</a-select-option
        ></a-select
      ><a-button :loading="loading" :aria-label="ct('REFRESH')" @click="reload"
        ><ReloadOutlined
      /></a-button>
    </div>
    <a-alert v-if="error" type="error" :message="error" show-icon class="mb-20" />
    <Loading v-if="loading" />
    <div v-else-if="instances.length" class="instance-grid">
      <article v-for="instance in instances" :key="instance.id" class="logical-card">
        <WorldArtwork :seed="instance.id" />
        <div class="logical-card-content">
          <div class="instance-version">
            <a-tag>{{
              instance.profile.loader === "vanilla" ? ct("VANILLA") : instance.profile.loader
            }}</a-tag
            ><span>MC {{ instance.profile.mcVersion }}</span>
          </div>
          <button class="instance-name" type="button" @click="open(instance)">
            {{ instance.name }}
          </button>
          <p class="pack-name">
            {{ instance.profile.packName || ct("NO_PACK")
            }}<span v-if="instance.profile.packRevision">
              · {{ instance.profile.packRevision }}</span
            >
          </p>
          <div class="instance-facts">
            <span>{{ ct("SAVE_COUNT", { count: instance.saves.length }) }}</span
            ><span>{{
              ct("ROOM_COUNT", { count: instance.saves.filter((s) => s.room).length })
            }}</span>
          </div>
          <div class="instance-footer">
            <span>{{ ct("OWNER") }} · {{ instance.ownerName }}</span
            ><a-button type="text" @click="open(instance)"
              >{{ ct("MANAGE") }} <ArrowRightOutlined
            /></a-button>
          </div>
        </div>
      </article>
    </div>
    <div v-else-if="!error" class="catalog-empty">
      <AppstoreOutlined />
      <h2>{{ ct(search || loader ? "NO_RESULTS" : "NO_INSTANCES") }}</h2>
      <p>{{ ct(data.canCreate ? "EMPTY_OWNER" : "EMPTY_MEMBER") }}</p>
      <a-button
        v-if="data.canCreate && !search && !loader"
        type="primary"
        @click="showCreate = true"
        ><PlusOutlined /> {{ ct("NEW_INSTANCE") }}</a-button
      >
    </div>
    <a-modal
      v-model:open="showCreate"
      :title="ct('NEW_INSTANCE')"
      :footer="null"
      :width="640"
      destroy-on-close
      ><a-tabs><a-tab-pane key="cloud" :tab="ct('CLOUD_CREATE')"><CloudImport v-if="showCreate" @done="imported" /></a-tab-pane><a-tab-pane key="advanced" :tab="ct('PROFILE_ONLY')"><InstanceEditor :busy="busy" @submit="create" /></a-tab-pane></a-tabs></a-modal>
    <a-modal
      v-model:open="showCreators"
      :title="ct('CREATE_PERMISSIONS')"
      :confirm-loading="busy"
      destroy-on-close
      @ok="saveCreators"
      ><p>{{ ct("CREATE_PERMISSIONS_NOTE") }}</p>
      <a-select
        v-model:value="creatorIds"
        mode="multiple"
        :options="users.map((u) => ({ value: u.id, label: u.name }))"
        style="width: 100%"
        :placeholder="ct('SELECT_USERS')"
    /></a-modal>
  </div>
</template>
<style scoped>
.catalog-page {
  max-width: 1440px;
  margin: 18px auto;
  color: var(--nc-parchment);
}
.catalog-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 30px;
}
.catalog-eyebrow {
  font: 11px var(--nc-font-mono);
  color: var(--nc-mist);
  letter-spacing: 0.14em;
}
h1 {
  font: 600 34px var(--nc-font-display);
  margin: 12px 0 10px;
}
.catalog-heading p {
  color: var(--nc-mist);
  margin: 0;
  line-height: 1.7;
  font-size: 14px;
}
.catalog-stats {
  display: flex;
  align-items: center;
  gap: 32px;
  border-bottom: var(--nc-hairline);
  padding: 20px 0;
  margin-bottom: 24px;
}
.catalog-stats > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.catalog-stats strong {
  font: 500 23px var(--nc-font-mono);
}
.catalog-stats span,
.catalog-stats .anticon {
  font-size: 12px;
  color: var(--nc-mist);
}
.catalog-rule {
  margin-left: auto;
}
.stat-dot {
  width: 8px;
  height: 8px;
  background: var(--nc-aurora);
  border-radius: 50%;
}
.catalog-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}
.catalog-toolbar :deep(.ant-input-search) {
  max-width: 360px;
}
.catalog-toolbar :deep(.ant-select) {
  min-width: 140px;
}
.catalog-toolbar > .ant-btn {
  margin-left: auto;
}
.instance-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 22px;
}
.logical-card {
  background: var(--nc-dusk);
  border: var(--nc-hairline);
  border-radius: 12px;
  overflow: hidden;
}
.logical-card-content {
  padding: 22px;
}
.instance-version {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--nc-mist);
  font: 12px var(--nc-font-mono);
}
.instance-name {
  display: block;
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  margin: 18px 0 10px;
  font: 600 22px var(--nc-font-display);
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}
.instance-name:focus-visible {
  outline: 2px solid var(--nc-aurora);
  outline-offset: 5px;
}
.pack-name {
  color: var(--nc-mist);
  font-size: 13px;
  min-height: 24px;
  margin-bottom: 20px;
}
.instance-facts {
  display: flex;
  gap: 20px;
  color: var(--nc-mist);
  font-size: 12px;
}
.instance-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-top: var(--nc-hairline);
  margin-top: 20px;
  padding-top: 14px;
}
.instance-footer > span {
  font-size: 12px;
  color: var(--nc-mist);
}
.catalog-empty {
  min-height: 340px;
  border: 1px dashed var(--nc-veil);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--nc-mist);
  padding: 28px;
  text-align: center;
}
.catalog-empty > .anticon {
  font-size: 32px;
}
.catalog-empty h2 {
  font-size: 18px;
  margin: 0;
}
.catalog-empty p {
  max-width: 540px;
}
@media (max-width: 1100px) {
  .instance-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .catalog-rule {
    display: none;
  }
}
@media (max-width: 650px) {
  .instance-grid {
    grid-template-columns: 1fr;
  }
  .catalog-heading {
    flex-direction: column;
    align-items: flex-start;
  }
  h1 {
    font-size: 28px;
  }
  .catalog-stats {
    gap: 18px;
  }
  .catalog-toolbar {
    flex-wrap: wrap;
  }
  .catalog-toolbar :deep(.ant-input-search) {
    max-width: none;
    width: 100%;
  }
}
</style>
