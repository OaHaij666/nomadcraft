<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { router } from "@/config/router";
import { can, ct, useCatalog } from "@/hooks/useCatalog";
import {
  catalogApi,
  type AccessGrant,
  type CatalogSave,
  type CatalogUser,
  type InstanceInput,
  type ModEntry,
  type PlayerRule,
  type SaveInput
} from "@/services/apis/catalog";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { Modal } from "ant-design-vue";
import {
  ArrowLeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  CopyOutlined,
  SettingOutlined,
  FolderOutlined,
  TeamOutlined,
  FileProtectOutlined,
  CodeOutlined,
  CloudServerOutlined
} from "@ant-design/icons-vue";
import RoomRuntime from "./RoomRuntime.vue";
import InstanceEditor from "./InstanceEditor.vue";
import CloudImport from "./CloudImport.vue";
import ReleaseEditor from "./ReleaseEditor.vue";
import type { PublishedRelease } from "../../../../shared/nomad-catalog";
import SaveEditor from "./SaveEditor.vue";
import AccessEditor from "./AccessEditor.vue";
import ModManifest from "./ModManifest.vue";
import PlayerPolicy from "./PlayerPolicy.vue";
const tRuntime=()=>ct("RUNTIME_NETWORK");
const route = useRoute();
const { data, loading, error, busy, reload, mutate } = useCatalog();
const { isAdmin, state } = useAppStateStore();
const instance = computed(() =>
  data.value.instances.find((i) => i.id === String(route.query.id ?? ""))
);
const owner = computed(
  () => !!instance.value && (isAdmin.value || instance.value.ownerId === state.userInfo?.uuid)
);
const tab = ref("saves");
const users = ref<CatalogUser[]>([]);
const activeSaveId = ref("");
const activeSave = computed(() => instance.value?.saves.find((s) => s.id === activeSaveId.value));
const editingRelease = ref<PublishedRelease>();
const showInstanceEditor = ref(false);
const showSaveEditor = ref(false);
const editingSave = ref<CatalogSave>();
const showRoom = ref(false);
const roomName = ref("");
const roomSave = ref<CatalogSave>();
const runtimeSave = ref<CatalogSave>();
const hasOpenRooms = computed(
  () => instance.value?.saves.some((s) => s.room?.desiredState === "open") ?? false
);
const load = async () => {
  await reload();
  if (owner.value) {
    try {
      users.value = await catalogApi.users();
    } catch {
      users.value = [];
    }
  }
};
watch(instance, (value) => {
  if (value && !value.saves.some((s) => s.id === activeSaveId.value))
    activeSaveId.value = value.saves[0]?.id ?? "";
});
watch(() => route.query.id, load);
let statusTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {load();statusTimer=setInterval(async()=>{if(busy.value||loading.value||!instance.value?.saves.some(s=>s.room?.desiredState==='open'||['starting','stopping','checkpointing'].includes(s.hosting?.phase??'')))return;try{data.value=await catalogApi.list();}catch{for(const i of data.value.instances)for(const s of i.saves)if(s.hosting)s.hosting={...s.hosting,joinAddress:null};}},5000);});
onUnmounted(()=>{if(statusTimer)clearInterval(statusTimer);});
const saveInstance = async (input: InstanceInput) => {
  if (instance.value && (await mutate(() => catalogApi.update(instance.value!.id, input))))
    showInstanceEditor.value = false;
};
const newSave = () => {
  editingSave.value = undefined;
  showSaveEditor.value = true;
};
const editSave = (save: CatalogSave) => {
  editingSave.value = save;
  showSaveEditor.value = true;
};
const saveWorld = async (input: SaveInput) => {
  if (
    instance.value &&
    (await mutate(() => catalogApi.save(instance.value!.id, editingSave.value?.id ?? null, input)))
  )
    showSaveEditor.value = false;
};
const clone = async () => {
  if (!instance.value) return;
  let id = "";
  if (
    await mutate(async () => {
      id = (await catalogApi.clone(instance.value!.id)).id;
    })
  )
    router.push({ path: "/catalog/detail", query: { id } });
};
const deleteInstance = () => {
  if (!instance.value) return;
  Modal.confirm({
    title: ct("DELETE_INSTANCE"),
    content: ct("DELETE_INSTANCE_NOTE"),
    okType: "danger",
    onOk: async () => {
      if (await mutate(() => catalogApi.delete(instance.value!.id))) router.push("/catalog");
    }
  });
};
const deleteSave = (save: CatalogSave) =>
  Modal.confirm({
    title: ct("DELETE_SAVE"),
    content: ct("DELETE_SAVE_NOTE", { name: save.name }),
    okType: "danger",
    onOk: () => mutate(() => catalogApi.deleteSave(instance.value!.id, save.id))
  });
const createRoom = (save: CatalogSave) => {
  roomSave.value = save;
  roomName.value = save.name;
  showRoom.value = true;
};
const saveRoom = async () => {
  if (
    instance.value &&
    roomSave.value &&
    (await mutate(() =>
      catalogApi.room(instance.value!.id, roomSave.value!.id, { name: roomName.value }, true)
    ))
  )
    showRoom.value = false;
};
const roomIntent = (save: CatalogSave) => {
  if (instance.value && save.room)
    mutate(() =>
      catalogApi.room(instance.value!.id, save.id, {
        name: save.room!.name,
        desiredState: save.room!.desiredState === "open" ? "closed" : "open"
      })
    );
};
const saveAccess = (grants: AccessGrant[]) =>
  mutate(() => catalogApi.grants(instance.value!.id, grants));
const saveMods = (mods: ModEntry[]) => mutate(() => catalogApi.mods(instance.value!.id, mods));
const savePlayers = (players: PlayerRule[]) =>
  activeSave.value &&
  mutate(() => catalogApi.players(instance.value!.id, activeSave.value!.id, players));
const time = (value: number) => new Date(value).toLocaleString();
const selectSave = (save: CatalogSave, target: string) => {
  activeSaveId.value = save.id;
  tab.value = target;
};
const operationalTools = [
  { key: "CONSOLE", icon: CodeOutlined, note: "CONSOLE_NOTE" },
  { key: "FILES", icon: FolderOutlined, note: "FILES_NOTE" },
  { key: "BACKUPS", icon: FileProtectOutlined, note: "BACKUPS_NOTE" },
  { key: "SCHEDULE", icon: SettingOutlined, note: "SCHEDULE_NOTE" }
];
</script>
<template>
  <div class="detail-page">
    <a-button type="text" class="back-link" @click="router.push('/catalog')"
      ><ArrowLeftOutlined /> {{ ct("CENTER") }}</a-button
    >
    <a-alert v-if="error" type="error" :message="error" show-icon />
    <Loading v-if="loading && !instance" />
    <div v-else-if="!instance" class="detail-empty">
      <h2>{{ ct("NO_ACCESS") }}</h2>
      <p>{{ ct("NO_ACCESS_NOTE") }}</p>
    </div>
    <template v-else>
      <header class="detail-heading">
        <div>
          <span class="catalog-eyebrow">MINECRAFT JAVA / LOGICAL INSTANCE</span>
          <h1>{{ instance.name }}</h1>
          <div class="detail-meta">
            <a-tag>{{ instance.profile.loader }}</a-tag
            ><span>MC {{ instance.profile.mcVersion }}</span
            ><span v-if="instance.profile.loaderVersion">{{ instance.profile.loaderVersion }}</span
            ><span>{{ ct("OWNER") }} · {{ instance.ownerName }}</span>
          </div>
        </div>
        <a-space wrap
          ><a-button :loading="loading" :aria-label="ct('REFRESH')" @click="load"
            ><ReloadOutlined /></a-button
          ><a-button
            v-if="can(instance, 'instance.update')"
            :disabled="hasOpenRooms"
            @click="showInstanceEditor = true"
            ><SettingOutlined /> {{ ct("EDIT_INSTANCE") }}</a-button
          ><a-button
            v-if="data.canCreate && can(instance, 'instance.read')"
            :loading="busy"
            @click="clone"
            ><CopyOutlined /> {{ ct("CLONE") }}</a-button
          ><a-button v-if="can(instance, 'save.create')" type="primary" @click="newSave"
            ><PlusOutlined /> {{ ct("NEW_SAVE") }}</a-button
          ></a-space
        >
      </header>
      <div class="instance-strip">
        <span
          >{{ instance.profile.packName || ct("NO_PACK")
          }}<small v-if="instance.profile.packRevision">
            · {{ instance.profile.packRevision }}</small
          ></span
        ><span>Java {{ instance.profile.javaMajor }}</span
        ><span>{{ instance.profile.memoryMb }} MiB</span
        ><span>{{ ct("SAVE_COUNT", { count: instance.saves.length }) }}</span
        ><span class="instance-strip-end">{{ ct("REVISION", { count: instance.revision }) }}</span>
      </div>
      <a-tabs v-model:activeKey="tab" class="detail-tabs">
        <a-tab-pane key="saves" :tab="ct('SAVES')">
          <div class="section-heading">
            <div>
              <h2>{{ ct("SAVES") }}</h2>
              <p>{{ ct("SAVES_NOTE") }}</p>
            </div>
          </div>
          <a-empty v-if="!instance.saves.length" :description="ct('NO_SAVES')" />
          <div class="save-grid">
            <article v-for="save in instance.saves" :key="save.id" class="save-card">
              <div class="save-card-heading">
                <FolderOutlined />
                <h3>{{ save.name }}</h3>
                <a-tag>{{
                  ct(
                    save.room?.desiredState === "open"
                      ? save.hosting?.joinAddress && ["ready", "checkpointing"].includes(save.hosting.phase) ? "HOST_READY" : save.hosting?.phase === "starting" ? "HOST_STARTING" : "AWAITING_HOST"
                      : save.room
                      ? "ROOM_CLOSED"
                      : "NO_ROOM"
                  )
                }}</a-tag>
              </div>
              <p class="save-description">
                {{
                  save.description ||
                  ct("SAVE_RULES_SUMMARY", {
                    mode: ct("MODE_" + save.rules.gameMode),
                    difficulty: ct("DIFFICULTY_" + save.rules.difficulty)
                  })
                }}
              </p>
              <dl>
                <div>
                  <dt>{{ ct("ROOM") }}</dt>
                  <dd>{{ save.room?.name ?? "—" }}</dd>
                </div>
                <div>
                  <dt>{{ ct("MAX_PLAYERS") }}</dt>
                  <dd>{{ save.rules.maxPlayers }}</dd>
                </div>
                <div>
                  <dt>{{ ct("WHITELIST") }}</dt>
                  <dd>{{ ct(save.rules.whitelist ? "ON" : "OFF") }}</dd>
                </div>
                <div>
                  <dt>{{ ct("UPDATED") }}</dt>
                  <dd>{{ time(save.updatedAt) }}</dd>
                </div>
              </dl>
              <div v-if="save.room?.desiredState === 'open'" class="room-message">
                <template v-if="save.hosting?.joinAddress"><CloudServerOutlined /> {{ct('HOST_JOIN')}} <a-typography-text copyable>{{save.hosting.joinAddress}}</a-typography-text><br /><span>{{ct('HOST_HELD_BY',{name:save.hosting.nodeName})}}</span></template>
                <template v-else><CloudServerOutlined /> {{ct(save.hosting?.phase === 'stopping' ? 'HOST_STOPPING' : save.hosting?.phase === 'starting' ? 'HOST_STARTING_NOTE' : 'ROOM_EXECUTOR_PENDING')}}</template>
              </div>
              <p v-if="save.hosting?.checkpoint" class="policy-note">{{ct('HOST_CHECKPOINT')}} · {{time(save.hosting.checkpoint.at)}} · {{(save.hosting.checkpoint.size / 1048576).toFixed(1)}} MiB</p>
              <p class="policy-note">{{ ct('PINNED_RELEASE') }}: {{ instance.releases?.find(r => r.id === save.releaseId)?.profile.packRevision ?? ct('NO_RELEASE') }}</p>
              <a-select v-if="can(instance, 'instance.read') && can(instance, 'save.update', save.id) && instance.releases?.length" :value="save.releaseId ?? undefined" :disabled="busy || save.room?.desiredState === 'open'" :aria-label="ct('PINNED_RELEASE')" style="width: 100%; margin-bottom: 18px" @change="(value) => mutate(() => catalogApi.bindRelease(instance!.id, save.id, String(value)))">
                <a-select-option v-for="release in instance.releases" :key="release.id" :value="release.id">{{ release.profile.packName }} · {{ release.profile.packRevision }}</a-select-option>
              </a-select>
              <a-button v-if="can(instance,'room.manage',save.id)" style="margin-bottom:16px" @click="runtimeSave=save">{{tRuntime()}}</a-button>
              <div class="save-actions">
                <a-button
                  v-if="can(instance, 'room.manage', save.id) && !save.room"
                  type="primary"
                  :loading="busy"
                  @click="createRoom(save)"
                  >{{ ct("CREATE_ROOM") }}</a-button
                ><a-button
                  v-else-if="can(instance, 'room.manage', save.id) && save.room"
                  :loading="busy"
                  :type="save.room.desiredState === 'closed' ? 'primary' : 'default'"
                  @click="roomIntent(save)"
                  >{{
                    ct(save.room.desiredState === "closed" ? "REQUEST_OPEN" : "CLOSE_ROOM")
                  }}</a-button
                ><a-button
                  v-if="can(instance, 'save.update', save.id)"
                  :disabled="save.room?.desiredState === 'open'"
                  @click="editSave(save)"
                  >{{ ct("SAVE_SETTINGS") }}</a-button
                ><a-button @click="selectSave(save, 'players')"
                  ><TeamOutlined /> {{ ct("PLAYERS") }}</a-button
                ><a-button
                  v-if="can(instance, 'save.delete', save.id)"
                  type="text"
                  danger
                  :disabled="save.room?.desiredState === 'open'"
                  @click="deleteSave(save)"
                  >{{ ct("DELETE") }}</a-button
                >
              </div>
            </article>
          </div>
        </a-tab-pane>
        <a-tab-pane key="releases" :tab="ct('RELEASES')">
          <p class="policy-note">{{ ct('RELEASE_NOTE') }}</p>
          <CloudImport v-if="can(instance, 'mods.manage') && can(instance, 'instance.update')" :instance-id="instance.id" @done="reload" />
          <a-list :data-source="[...(instance.releases ?? [])].reverse()">
            <template #renderItem="{ item }"><a-list-item><div>
              <strong>{{ item.profile.packName }} · {{ item.profile.packRevision }}</strong>
              <p>MC {{ item.profile.mcVersion }} / {{ item.profile.loader }} {{ item.profile.loaderVersion }} · {{ item.format }} · {{ (item.size / 1048576).toFixed(2) }} MB</p>
              <a-button v-if="can(instance, 'mods.manage') && can(instance, 'instance.update')" size="small" style="margin:12px 0" @click="editingRelease = item">{{ct('CONFIG_RELEASE_PUBLISH')}}</a-button>
              <small style="word-break: break-all">SHA256 {{ item.sha256 }}</small>
              <p v-if="item.install">{{Object.entries(item.install).filter(([k,v]) => k !== 'minecraft' && v).map(([k,v]) => k + ' ' + v).join(' · ') || ct('VANILLA')}}</p>
              <a-collapse style="margin-top:14px"><a-collapse-panel key="runtime" :header="ct('LAUNCH_OPTIONS')"><a-descriptions :column="2" size="small"><a-descriptions-item :label="ct('JAVA')">{{item.profile.javaMajor}}</a-descriptions-item><a-descriptions-item :label="ct('MEMORY')">{{item.profile.launch?.memoryMode === 'auto' ? ct('MEMORY_AUTO') : item.profile.memoryMb + ' MiB'}}</a-descriptions-item><a-descriptions-item :label="ct('WINDOW_MODE')">{{ct('WINDOW_' + (item.profile.launch?.windowMode ?? 'default'))}}</a-descriptions-item><a-descriptions-item :label="ct('AUTO_JOIN')">{{item.profile.launch?.autoJoin || '—'}}</a-descriptions-item><a-descriptions-item :label="ct('JVM_ARGS')">{{item.profile.launch?.jvmArgs || '—'}}</a-descriptions-item><a-descriptions-item :label="ct('GAME_ARGS')">{{item.profile.launch?.gameArgs || '—'}}</a-descriptions-item></a-descriptions></a-collapse-panel></a-collapse>
              <p v-if="item.server">{{ct('SERVER_DEPLOY_READY')}} · {{item.server.type}} {{item.server.version}} / Java {{item.server.javaMajor}} / {{item.server.memoryMb}} MiB</p>
              <a-button v-if="item.server && can(instance, 'instance.read')" :loading="busy" @click="mutate(() => catalogApi.downloadServer(instance!.id, item.id))">{{ct('SERVER_DOWNLOAD')}}</a-button>
            </div></a-list-item></template>
          </a-list>
          <a-empty v-if="!instance.releases?.length" :description="ct('NO_RELEASE')" />
        </a-tab-pane>
        <a-tab-pane key="runtime" :tab="ct('RUNTIME')"
          ><div class="section-heading">
            <div>
              <h2>{{ ct("RUNTIME") }}</h2>
              <p>{{ ct("RUNTIME_NOTE") }}</p>
            </div>
          </div>
          <a-descriptions bordered :column="2"
            ><a-descriptions-item :label="ct('MC_VERSION')">{{
              instance.profile.mcVersion
            }}</a-descriptions-item
            ><a-descriptions-item :label="ct('LOADER')"
              >{{ instance.profile.loader }}
              {{ instance.profile.loaderVersion }}</a-descriptions-item
            ><a-descriptions-item :label="ct('PACK_NAME')">{{
              instance.profile.packName || "—"
            }}</a-descriptions-item
            ><a-descriptions-item :label="ct('PACK_REVISION')">{{
              instance.profile.packRevision || "—"
            }}</a-descriptions-item
            ><a-descriptions-item :label="ct('JAVA')">{{
              instance.profile.javaMajor
            }}</a-descriptions-item
            ><a-descriptions-item :label="ct('MEMORY')"
              >{{ instance.profile.memoryMb }} MiB</a-descriptions-item
            ><a-descriptions-item :label="ct('ARTIFACT')" :span="2">{{
              instance.profile.artifact || "—"
            }}</a-descriptions-item
            ><a-descriptions-item :label="ct('HASH')" :span="2"
              ><code>{{ instance.profile.artifactSha256 || "—" }}</code></a-descriptions-item
            ><a-descriptions-item :label="ct('DESCRIPTION')" :span="2">{{
              instance.description || "—"
            }}</a-descriptions-item></a-descriptions
          >
          <p class="policy-note">{{ ct("VERSION_LOCK_NOTE") }}</p></a-tab-pane
        >
        <a-tab-pane key="mods" :tab="ct('MODS')"
          ><ModManifest
            :initial="instance.mods"
            :editable="can(instance, 'mods.manage') && !hasOpenRooms"
            :busy="busy"
            @submit="saveMods"
        /></a-tab-pane>
        <a-tab-pane key="players" :tab="ct('PLAYERS')"
          ><a-select
            v-model:value="activeSaveId"
            class="save-picker"
            :placeholder="ct('SELECT_SAVE')"
            :options="instance.saves.map((s) => ({ value: s.id, label: s.name }))" /><PlayerPolicy
            v-if="activeSave"
            :key="activeSave.id"
            :initial="activeSave.players"
            :editable="owner && activeSave.room?.desiredState !== 'open'"
            :busy="busy"
            @submit="savePlayers" /><a-empty v-else :description="ct('NO_SAVES')"
        /></a-tab-pane>
        <a-tab-pane key="access" :tab="ct('ACCESS')"
          ><AccessEditor
            :instance="instance"
            :users="users"
            :editable="owner"
            :busy="busy"
            @submit="saveAccess"
        /></a-tab-pane>
        <a-tab-pane key="operations" :tab="ct('OPERATIONS')"
          ><div class="section-heading">
            <div>
              <h2>{{ ct("OPERATIONS") }}</h2>
              <p>{{ ct("OPERATIONS_NOTE") }}</p>
            </div>
            <a-button v-if="isAdmin" @click="router.push('/instances')"
              >{{ ct("EXISTING_RUNTIMES") }} →</a-button
            >
          </div>
          <div class="operation-grid">
            <article v-for="tool in operationalTools" :key="tool.key">
              <component :is="tool.icon" />
              <h3>{{ ct(tool.key) }}</h3>
              <p>{{ ct(tool.note) }}</p>
              <a-tag>{{ ct("EXECUTOR_REQUIRED") }}</a-tag>
            </article>
          </div>
          <p class="policy-note">{{ ct("NO_EXECUTION_CLAIM") }}</p></a-tab-pane
        >
        <a-tab-pane key="activity" :tab="ct('ACTIVITY')"
          ><div class="section-heading">
            <div>
              <h2>{{ ct("ACTIVITY") }}</h2>
              <p>{{ ct("ACTIVITY_NOTE") }}</p>
            </div>
          </div>
          <a-empty v-if="!instance.events.length" :description="ct('NO_ACTIVITY')" />
          <div v-for="event in instance.events" :key="event.id" class="activity-row">
            <span class="event-mark"></span>
            <div>
              <strong>{{ ct("EVENT_" + event.action.replace(".", "_")) }}</strong
              ><small
                >{{ event.actor
                }}<span v-if="event.saveId">
                  ·
                  {{
                    instance.saves.find((s) => s.id === event.saveId)?.name ?? ct("DELETED_SAVE")
                  }}</span
                ></small
              >
            </div>
            <time>{{ time(event.at) }}</time>
          </div></a-tab-pane
        >
      </a-tabs>
      <div v-if="owner" class="danger-zone">
        <div>
          <strong>{{ ct("DELETE_INSTANCE") }}</strong>
          <p>{{ ct("DELETE_INSTANCE_GUARD") }}</p>
        </div>
        <a-button danger :disabled="instance.saves.length > 0" @click="deleteInstance">{{
          ct("DELETE")
        }}</a-button>
      </div>
      <a-modal v-if="editingRelease && instance" :open="!!editingRelease" :title="ct('LAUNCH_OPTIONS')" :footer="null" :width="760" @cancel="editingRelease = undefined"><ReleaseEditor :key="editingRelease.id" :instance-id="instance.id" :release="editingRelease" @done="editingRelease = undefined; reload()" /></a-modal>
    <a-modal v-if="runtimeSave && instance" :open="true" :title="ct('RUNTIME_NETWORK')" :footer="null" :width="740" @cancel="runtimeSave=undefined"><RoomRuntime :key="runtimeSave.id" :instance-id="instance.id" :save="runtimeSave" @done="runtimeSave=undefined;reload()" /></a-modal>
    <a-modal
        v-model:open="showInstanceEditor"
        :title="ct('EDIT_INSTANCE')"
        :footer="null"
        :width="640"
        destroy-on-close
        ><InstanceEditor
          :initial="{
            name: instance.name,
            description: instance.description,
            profile: instance.profile
          }"
          :identity-locked="instance.saves.length > 0"
          :busy="busy"
          @submit="saveInstance"
      /></a-modal>
      <a-modal
        v-model:open="showSaveEditor"
        :title="ct(editingSave ? 'SAVE_SETTINGS' : 'NEW_SAVE')"
        :footer="null"
        :width="640"
        destroy-on-close
        ><SaveEditor
          :initial="
            editingSave
              ? {
                  name: editingSave.name,
                  description: editingSave.description,
                  rules: editingSave.rules
                }
              : undefined
          "
          :busy="busy"
          @submit="saveWorld"
      /></a-modal>
      <a-modal
        v-model:open="showRoom"
        :title="ct('CREATE_ROOM')"
        :confirm-loading="busy"
        :ok-button-props="{ disabled: !roomName.trim() }"
        destroy-on-close
        @ok="saveRoom"
        ><p>{{ ct("ONE_ROOM_NOTE") }}</p>
        <a-input v-model:value="roomName" :placeholder="ct('ROOM_NAME')" :maxlength="120"
      /></a-modal>
    </template>
  </div>
</template>
<style scoped>
.detail-page {
  max-width: 1440px;
  margin: 12px auto;
  color: var(--nc-parchment);
}
.back-link {
  margin-left: -12px;
  margin-bottom: 20px;
}
.detail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 26px;
}
.catalog-eyebrow {
  font: 11px var(--nc-font-mono);
  color: var(--nc-mist);
  letter-spacing: 0.12em;
}
h1 {
  font: 600 32px var(--nc-font-display);
  margin: 12px 0 14px;
}
.detail-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12px;
  color: var(--nc-mist);
}
.instance-strip {
  display: flex;
  gap: 24px;
  align-items: center;
  flex-wrap: wrap;
  border: var(--nc-hairline);
  background: var(--nc-dusk);
  border-radius: 10px;
  padding: 18px 22px;
  margin-bottom: 24px;
  font-size: 12px;
  color: var(--nc-mist);
}
.instance-strip-end {
  margin-left: auto;
  font-family: var(--nc-font-mono);
}
.detail-tabs :deep(.ant-tabs-content) {
  padding-top: 20px;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}
h2 {
  font-size: 18px;
  margin: 0 0 10px;
}
.section-heading p,
.policy-note {
  font-size: 13px;
  color: var(--nc-mist);
  line-height: 1.8;
}
.policy-note {
  margin-top: 22px;
}
.save-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.save-card {
  padding: 24px;
  border: var(--nc-hairline);
  background: var(--nc-dusk);
  border-radius: 12px;
}
.save-card-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.save-card-heading > .anticon {
  color: var(--nc-aurora);
  font-size: 22px;
}
h3 {
  font-size: 18px;
  margin: 0;
}
.save-card-heading > .ant-tag {
  margin-left: auto;
}
.save-description {
  font-size: 13px;
  color: var(--nc-mist);
  margin: 18px 0 22px;
  min-height: 22px;
}
dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}
dt {
  font-size: 11px;
  color: var(--nc-mist);
  margin-bottom: 6px;
}
dd {
  font-size: 13px;
  margin: 0;
  overflow-wrap: anywhere;
}
.save-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  border-top: var(--nc-hairline);
  padding-top: 18px;
}
.room-message {
  font-size: 12px;
  color: var(--nc-mist);
  margin: 10px 0 22px;
  line-height: 1.8;
}
.save-picker {
  min-width: 260px;
  margin-bottom: 26px;
}
.operation-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.operation-grid article {
  border: var(--nc-hairline);
  border-radius: 10px;
  padding: 24px;
  background: var(--nc-dusk);
}
.operation-grid .anticon {
  font-size: 22px;
  color: var(--nc-mist);
  margin-bottom: 20px;
}
.operation-grid p {
  font-size: 13px;
  color: var(--nc-mist);
  line-height: 1.8;
  min-height: 46px;
}
.activity-row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 18px 0;
  border-bottom: var(--nc-hairline);
  font-size: 13px;
}
.event-mark {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nc-aurora);
}
.activity-row strong {
  font-weight: 500;
}
.activity-row small {
  display: block;
  color: var(--nc-mist);
  margin-top: 7px;
}
.activity-row time {
  margin-left: auto;
  color: var(--nc-mist);
  font: 11px var(--nc-font-mono);
}
.danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  border-top: var(--nc-hairline);
  margin-top: 44px;
  padding-top: 24px;
  font-size: 13px;
}
.danger-zone p {
  color: var(--nc-mist);
  font-size: 12px;
  margin: 8px 0;
}
.detail-empty {
  padding: 80px 20px;
  text-align: center;
  color: var(--nc-mist);
}
@media (max-width: 850px) {
  .save-grid {
    grid-template-columns: 1fr;
  }
  .detail-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .instance-strip {
    gap: 14px;
  }
}
@media (max-width: 650px) {
  .operation-grid {
    grid-template-columns: 1fr;
  }
  .activity-row {
    flex-wrap: wrap;
  }
  .activity-row time {
    width: 100%;
    margin-left: 22px;
  }
  h1 {
    font-size: 26px;
  }
  dl {
    grid-template-columns: 1fr;
  }
  .save-card {
    padding: 18px;
  }
  .detail-tabs :deep(.ant-tabs-nav) {
    max-width: calc(100vw - 32px);
  }
}
</style>
