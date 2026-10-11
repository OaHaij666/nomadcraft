<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { catalogApi } from "@/services/apis/catalog";
import { catalogError, ct } from "@/hooks/useCatalog";
import { DEFAULT_INSTALL, DEFAULT_LAUNCH, DEFAULT_PROFILE, DEFAULT_SERVER, type InstallChoice, type InstallSelection, type RuntimeProfile, type ServerSettings } from "../../../../shared/nomad-catalog";
import LaunchOptions from "./LaunchOptions.vue";
const props = defineProps<{instanceId?: string}>();
const emit = defineEmits<{done: [id: string]}>();
const mode = ref("upload"), name = ref(""), version = ref(""), file = ref<File>();
const versionType = ref("release");
const versions = ref<Array<{id: string; type?: string; releasedAt: string}>>([]);
const filteredVersions = computed(() => versions.value.filter(v => !versionType.value || (v.type ?? 'release') === versionType.value));
const runtime = ref<RuntimeProfile>({...DEFAULT_PROFILE, packRevision: "1", javaMajor:0, launch: {...DEFAULT_LAUNCH}});
const install = ref<InstallSelection>({...DEFAULT_INSTALL});
const serverEnabled = ref(false), server = ref<ServerSettings>({...DEFAULT_SERVER});
const policy = ref({maxGiB:5, maxBytes:5 * 1024 ** 3});
const busy = ref(false), loading = ref(false), loaded = ref(false);
const choices = ref<Record<string, InstallChoice[]>>({});
const componentLoading = ref<Record<string, boolean>>({}), componentErrors = ref<Record<string, string>>({});
const components = ['forge','neoforge','fabric','fabricApi','optifine','optifabric','liteloader'] as const;
let generation = 0;
const loadComponent = async (component: string, epoch = generation) => {
  if (!version.value) return;
  const mc = version.value; componentLoading.value[component] = true; componentErrors.value[component] = "";
  try { const result = await catalogApi.components(component, mc); if (epoch === generation) choices.value[component] = result; }
  catch (e) { if (epoch === generation) componentErrors.value[component] = catalogError(e); }
  finally { if (epoch === generation) componentLoading.value[component] = false; }
};
const loadVersions = async () => {
  if (versions.value.length || loading.value) return;
  loading.value = true;
  try { versions.value = await catalogApi.officialVersions(); } catch (e) { message.error(catalogError(e)); } finally { loading.value = false; }
};
watch(version, async () => {
  generation++; const epoch = generation;
  install.value = {...DEFAULT_INSTALL, minecraft:version.value}; choices.value = {}; componentErrors.value = {}; server.value.version = "";
  if (!version.value) return;
  const parts = version.value.split('.').map(Number);
  const javaMajor = parts[0] >= 26 ? 25 : parts[1] >= 21 || (parts[1] === 20 && parts[2] >= 5) ? 21 : parts[1] >= 18 ? 17 : parts[1] >= 17 ? 16 : 8;
  server.value.javaMajor = javaMajor;
  await Promise.allSettled(components.map(c => loadComponent(c, epoch)));
  if (serverEnabled.value && server.value.type === 'paper') await loadComponent('paper', epoch);
});
watch(() => server.value.type, async () => {server.value.version = ""; if (server.value.type !== 'vanilla') await loadComponent(server.value.type);});
watch(serverEnabled, async enabled => {if (enabled) {await loadVersions(); if (version.value && server.value.type !== 'vanilla') await loadComponent(server.value.type);}});
watch(mode, () => { if (mode.value === 'official') loadVersions(); });
const choose = (key: keyof InstallSelection, value: string | undefined) => {
  install.value[key] = value ?? "";
  if (['forge','neoforge','fabric'].includes(key) && value) for (const c of ['forge','neoforge','fabric']) if (c !== key) install.value[c as keyof InstallSelection] = "";
  if (!install.value.fabric) { install.value.fabricApi = ""; install.value.optifabric = ""; }
  if (install.value.neoforge) {install.value.optifine = ""; install.value.liteloader = "";}
  if (install.value.fabric) install.value.liteloader = "";
  if (!install.value.optifine) install.value.optifabric = "";
};
const compatible = computed(() => !(install.value.fabric && install.value.optifine && !install.value.optifabric));
const selectFile = (event: Event) => {
  const next = (event.target as HTMLInputElement).files?.[0];
  if (next && next.size > policy.value.maxBytes) { message.error(ct('UPLOAD_TOO_LARGE', {max:policy.value.maxGiB})); file.value = undefined; (event.target as HTMLInputElement).value = ''; return; }
  file.value = next;
};
const canPublish = computed(() => loaded.value && !busy.value && (mode.value === 'upload' ? !!file.value : !!version.value && compatible.value) && (!serverEnabled.value || (server.value.eulaAccepted && (server.value.type === 'vanilla' || !!server.value.version))));
const publish = async () => {
  if (!canPublish.value) return;
  busy.value = true;
  try {
    const options = {profile: {...runtime.value, packName:name.value}, ...(mode.value === 'official' ? {install:install.value} : {}), ...(serverEnabled.value ? {server:server.value} : {})};
    const r = mode.value === 'upload' ? await catalogApi.import(file.value!, name.value, props.instanceId, options) : await catalogApi.official(version.value, name.value, props.instanceId, options);
    message.success(ct('PUBLISHED')); emit('done', props.instanceId ?? r.id);
  } catch (e) { message.error(catalogError(e)); } finally { busy.value = false; }
};
onMounted(async () => {try {policy.value = await catalogApi.policy(); loaded.value = true;} catch(e) {message.error(catalogError(e));}});
</script>
<template>
  <a-form :model="{name,version}" layout="vertical" @finish="publish">
    <a-form-item :label="ct('SOURCE')"><a-radio-group v-model:value="mode">
      <a-radio-button value="upload">{{ct('UPLOAD_PACK')}}</a-radio-button><a-radio-button value="official">{{ct('OFFICIAL_INSTALL')}}</a-radio-button>
    </a-radio-group></a-form-item>
    <a-form-item v-if="!instanceId" :label="ct('NAME')"><a-input v-model:value="name" :placeholder="ct('PACK_NAME_AUTO')" :maxlength="120" /></a-form-item>
    <template v-if="mode === 'upload'"><a-form-item :label="ct('PACK_FILE')">
      <input type="file" accept=".mrpack,.zip" :aria-label="ct('PACK_FILE')" :disabled="busy || !loaded" @change="selectFile" />
      <p class="import-note">{{ct('PACK_FORMAT_NOTE', {max:policy.maxGiB})}}</p>
      <p v-if="file" class="import-note">{{file.name}} · {{(file.size / 1024 ** 3).toFixed(2)}} GiB</p>
    </a-form-item><p class="import-note">{{ct('IMPORT_COMPONENT_NOTE')}}</p></template>
    <template v-if="mode === 'official' || serverEnabled">
      <a-form-item :label="ct('VERSION_CATEGORY')"><a-radio-group v-model:value="versionType"><a-radio-button value="release">{{ct('VERSIONS_RELEASE')}}</a-radio-button><a-radio-button value="snapshot">{{ct('VERSIONS_SNAPSHOT')}}</a-radio-button><a-radio-button value="">{{ct('VERSIONS_ALL')}}</a-radio-button></a-radio-group></a-form-item>
      <a-form-item :label="ct('MC_VERSION')"><a-select v-model:value="version" :loading="loading" show-search :placeholder="ct('CHOOSE_OFFICIAL')"><a-select-option v-for="v in filteredVersions" :key="v.id" :value="v.id">{{v.id}} · {{v.type ?? 'release'}}</a-select-option></a-select></a-form-item>
    </template>
    <section v-if="mode === 'official' && version" class="component-grid">
      <article v-for="component in components" :key="component" class="component-card">
        <strong>{{ct('COMPONENT_' + component)}}</strong>
        <a-select :value="install[component] || undefined" :loading="componentLoading[component]" :disabled="((component === 'fabricApi' || component === 'optifabric') && !install.fabric) || (component === 'optifabric' && !install.optifine)" allow-clear show-search :placeholder="ct('NO_COMPONENT')" style="width:100%; margin-top:10px" :aria-label="ct('COMPONENT_' + component)" @update:value="choose(component, $event === undefined ? undefined : String($event))">
          <a-select-option v-for="choice in choices[component] ?? []" :key="choice.id" :value="choice.id">{{choice.label}}{{choice.stable ? '' : ' · ' + ct('PREVIEW_VERSION')}}</a-select-option>
        </a-select>
        <p v-if="componentErrors[component]" class="component-error">{{componentErrors[component]}} <a @click="loadComponent(component)">{{ct('RETRY')}}</a></p>
        <small v-else-if="!componentLoading[component] && !choices[component]?.length">{{ct('NO_COMPATIBLE_VERSION')}}</small>
      </article>
    </section>
    <a-alert v-if="!compatible" type="warning" :message="ct('OPTIFABRIC_REQUIRED')" show-icon style="margin:16px 0" />
    <a-collapse style="margin:20px 0"><a-collapse-panel key="launch" :header="ct('LAUNCH_OPTIONS')"><LaunchOptions v-model="runtime" /></a-collapse-panel></a-collapse>
    <a-form-item :label="ct('PREPARE_SERVER')"><a-switch v-model:checked="serverEnabled" /></a-form-item>
    <section v-if="serverEnabled" class="server-options">
      <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('SERVER_TYPE')"><a-select v-model:value="server.type"><a-select-option v-for="v in ['vanilla','paper','fabric','forge','neoforge']" :key="v" :value="v">{{v}}</a-select-option></a-select></a-form-item></a-col>
      <a-col :span="12"><a-form-item :label="ct('SERVER_BUILD')"><a-select v-if="server.type !== 'vanilla'" v-model:value="server.version" show-search :loading="componentLoading[server.type]" :disabled="!version"><a-select-option v-for="v in choices[server.type] ?? []" :key="v.id" :value="v.id">{{v.label}}</a-select-option></a-select><a-input v-else :value="version" disabled /></a-form-item></a-col></a-row>
      <p v-if="componentErrors[server.type]" class="component-error">{{componentErrors[server.type]}} <a @click="loadComponent(server.type)">{{ct('RETRY')}}</a></p>
      <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('JAVA')"><a-input-number v-model:value="server.javaMajor" :min="8" :max="99" style="width:100%" /></a-form-item></a-col><a-col :span="12"><a-form-item :label="ct('MEMORY')"><a-input-number v-model:value="server.memoryMb" :min="512" :max="262144" :step="512" addon-after="MiB" style="width:100%" /></a-form-item></a-col></a-row>
      <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('SERVER_PORT')"><a-input-number v-model:value="server.port" :min="1024" :max="65535" style="width:100%" /></a-form-item></a-col><a-col :span="12"><a-form-item label="MOTD"><a-input v-model:value="server.motd" :maxlength="120" /></a-form-item></a-col></a-row>
      <a-form-item :label="ct('JVM_ARGS')"><a-textarea v-model:value="server.jvmArgs" :maxlength="4000" :rows="2" /></a-form-item>
      <a-space direction="vertical"><a-checkbox v-model:checked="server.onlineMode">{{ct('ONLINE_MODE')}}</a-checkbox><a-checkbox v-model:checked="server.allowFlight">{{ct('ALLOW_FLIGHT')}}</a-checkbox><a-checkbox v-model:checked="server.enableCommandBlock">{{ct('COMMAND_BLOCK')}}</a-checkbox><a-checkbox v-model:checked="server.eulaAccepted">{{ct('ACCEPT_EULA')}}</a-checkbox></a-space>
      <p class="import-note">{{ct('SERVER_PREPARE_NOTE')}}</p>
    </section>
    <a-button type="primary" html-type="submit" :loading="busy" :disabled="!canPublish">{{ct(instanceId ? 'PUBLISH_RELEASE' : 'IMPORT_CREATE')}}</a-button>
  </a-form>
</template>
<style scoped>
.import-note {color:var(--nc-mist);font-size:12px;line-height:1.8;} input[type=file]{max-width:100%;}
.component-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}
.component-card{padding:16px;border:var(--nc-hairline);border-radius:8px;min-width:0;}.component-card small{display:block;margin-top:8px;color:var(--nc-mist);}
.component-error{font-size:12px;color:#b34c43;line-height:1.6;}.server-options{padding:20px;background:var(--nc-dusk);border-radius:8px;margin-bottom:20px;}
@media(max-width:600px){.component-grid{grid-template-columns:1fr;}}
</style>
