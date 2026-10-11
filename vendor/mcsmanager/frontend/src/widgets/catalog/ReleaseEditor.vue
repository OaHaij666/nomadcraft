<script setup lang="ts">
import { ref } from "vue";
import { cloneDeep } from "lodash";
import { message } from "ant-design-vue";
import { ct, catalogError } from "@/hooks/useCatalog";
import { catalogApi } from "@/services/apis/catalog";
import { DEFAULT_LAUNCH, type PublishedRelease } from "../../../../shared/nomad-catalog";
import LaunchOptions from "./LaunchOptions.vue";
const props = defineProps<{instanceId:string; release:PublishedRelease}>();
const emit = defineEmits<{done: []}>();
const runtime = ref(cloneDeep({...props.release.profile,launch:{...DEFAULT_LAUNCH,...props.release.profile.launch}}));
const server = ref(cloneDeep(props.release.server));
const busy = ref(false);
const submit = async () => {
  if(busy.value)return;busy.value=true;
  try{await catalogApi.configureRelease(props.instanceId,props.release.id,{profile:runtime.value,server:server.value});message.success(ct('PUBLISHED'));emit('done');}
  catch(e){message.error(catalogError(e));}finally{busy.value=false;}
};
</script>
<template><a-form :model="runtime" layout="vertical" @finish="submit">
  <a-alert type="info" :message="ct('CONFIG_RELEASE_NOTE')" show-icon style="margin-bottom:20px" />
  <p>MC {{release.profile.mcVersion}} · {{release.profile.loader}} {{release.profile.loaderVersion}}</p>
  <LaunchOptions v-model="runtime" />
  <a-collapse v-if="server" style="margin:20px 0"><a-collapse-panel key="server" :header="ct('SERVER_DEPLOY_READY')">
    <p>{{server.type}} {{server.version}}</p>
    <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('MEMORY')"><a-input-number v-model:value="server.memoryMb" :min="512" :max="262144" :step="512" /></a-form-item></a-col><a-col :span="12"><a-form-item :label="ct('SERVER_PORT')"><a-input-number v-model:value="server.port" :min="1024" :max="65535" /></a-form-item></a-col></a-row>
    <a-form-item :label="ct('JVM_ARGS')"><a-textarea v-model:value="server.jvmArgs" :rows="2" :maxlength="4000" /></a-form-item>
    <a-form-item label="MOTD"><a-input v-model:value="server.motd" :maxlength="120" /></a-form-item>
    <a-space direction="vertical"><a-checkbox v-model:checked="server.onlineMode">{{ct('ONLINE_MODE')}}</a-checkbox><a-checkbox v-model:checked="server.allowFlight">{{ct('ALLOW_FLIGHT')}}</a-checkbox><a-checkbox v-model:checked="server.enableCommandBlock">{{ct('COMMAND_BLOCK')}}</a-checkbox></a-space>
  </a-collapse-panel></a-collapse>
  <a-button html-type="submit" type="primary" :loading="busy" style="margin-top:20px">{{ct('CONFIG_RELEASE_PUBLISH')}}</a-button>
</a-form></template>
