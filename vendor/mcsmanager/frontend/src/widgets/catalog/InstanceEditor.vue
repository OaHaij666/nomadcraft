<script setup lang="ts">
import LaunchOptions from "./LaunchOptions.vue";
import { DEFAULT_LAUNCH } from "../../../../shared/nomad-catalog";
import { ref } from "vue";
import { cloneDeep } from "lodash";
import { ct } from "@/hooks/useCatalog";
import { DEFAULT_PROFILE, SERVER_LOADERS, type InstanceInput } from "@/services/apis/catalog";
const props = defineProps<{ initial?: InstanceInput; identityLocked?: boolean; busy?: boolean }>();
const emit = defineEmits<{ submit: [data: InstanceInput] }>();
const form = ref<InstanceInput>(
  cloneDeep(props.initial ?? { name: "", description: "", profile: DEFAULT_PROFILE })
);
form.value.profile.launch = {...DEFAULT_LAUNCH, ...form.value.profile.launch};
</script>
<template>
  <a-form :model="form" layout="vertical" @finish="emit('submit', form)">
    <a-form-item
      :label="ct('NAME')"
      name="name"
      :rules="[{ required: true, whitespace: true, message: ct('REQUIRED') }]"
      ><a-input v-model:value="form.name" :maxlength="120"
    /></a-form-item>
    <a-row :gutter="16"
      ><a-col :span="12"
        ><a-form-item
          :label="ct('MC_VERSION')"
          :name="['profile', 'mcVersion']"
          :rules="[{ required: true, whitespace: true, message: ct('REQUIRED') }]"
          ><a-input
            v-model:value="form.profile.mcVersion"
            placeholder="1.20.1"
            :disabled="identityLocked"
            :maxlength="40" /></a-form-item></a-col
      ><a-col :span="12"
        ><a-form-item :label="ct('LOADER')" :name="['profile', 'loader']"
          ><a-select v-model:value="form.profile.loader" :disabled="identityLocked"
            ><a-select-option v-for="loader in SERVER_LOADERS" :key="loader" :value="loader">{{
              loader === "vanilla" ? ct("VANILLA") : loader
            }}</a-select-option></a-select
          ></a-form-item
        ></a-col
      ></a-row
    >
    <a-form-item
      v-if="form.profile.loader !== 'vanilla'"
      :label="ct('LOADER_VERSION')"
      :name="['profile', 'loaderVersion']"
      ><a-input
        v-model:value="form.profile.loaderVersion"
        :disabled="identityLocked"
        :maxlength="80"
    /></a-form-item>
    <a-row :gutter="16"
      ><a-col :span="12"
        ><a-form-item :label="ct('PACK_NAME')" :name="['profile', 'packName']"
          ><a-input
            v-model:value="form.profile.packName"
            :disabled="identityLocked"
            :maxlength="120" /></a-form-item></a-col
      ><a-col :span="12"
        ><a-form-item :label="ct('PACK_REVISION')" :name="['profile', 'packRevision']"
          ><a-input
            v-model:value="form.profile.packRevision"
            :disabled="identityLocked"
            :maxlength="80" /></a-form-item></a-col
    ></a-row>
    <a-row :gutter="16"
      ><a-col :span="12"
        ><a-form-item :label="ct('JAVA')" :name="['profile', 'javaMajor']"
          ><a-input-number
            v-model:value="form.profile.javaMajor"
            :min="8"
            :max="99"
            style="width: 100%" /></a-form-item></a-col
      ><a-col :span="12"
        ><a-form-item :label="ct('MEMORY')" :name="['profile', 'memoryMb']"
          ><a-input-number
            v-model:value="form.profile.memoryMb"
            :min="512"
            :max="262144"
            :step="512"
            style="width: 100%" /></a-form-item></a-col
    ></a-row>
    <a-form-item :label="ct('ARTIFACT')" :name="['profile', 'artifact']"
      ><a-input v-model:value="form.profile.artifact" :disabled="identityLocked" :maxlength="240"
    /></a-form-item>
    <a-form-item :label="ct('HASH')" :name="['profile', 'artifactSha256']"
      ><a-input
        v-model:value="form.profile.artifactSha256"
        :disabled="identityLocked"
        :maxlength="64"
    /></a-form-item>
    <a-form-item :label="ct('DESCRIPTION')" name="description"
      ><a-textarea v-model:value="form.description" :rows="2" :maxlength="2000"
    /></a-form-item>
    <a-collapse><a-collapse-panel key="launch" :header="ct('LAUNCH_OPTIONS')"><LaunchOptions v-model="form.profile" /></a-collapse-panel></a-collapse>
    <p class="form-note">{{ ct(identityLocked ? "VERSION_LOCK_NOTE" : "LOGICAL_CREATE_NOTE") }}</p>
    <a-button type="primary" html-type="submit" :loading="busy">{{ ct("SAVE") }}</a-button>
  </a-form>
</template>
<style scoped>
.form-note {
  color: var(--nc-mist);
  font-size: 12px;
  line-height: 1.8;
}
</style>
