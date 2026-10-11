<script setup lang="ts">
import { ct } from "@/hooks/useCatalog";
import type { RuntimeProfile } from "../../../../shared/nomad-catalog";
const props = defineProps<{modelValue: RuntimeProfile}>();
const emit = defineEmits<{"update:modelValue": [value: RuntimeProfile]}>();
const set = (key: string, value: unknown) => emit("update:modelValue", {...props.modelValue, [key]:value});
const launch = (key: string, value: unknown) => emit("update:modelValue", {...props.modelValue, launch:{...props.modelValue.launch!, [key]:value}});
</script>
<template>
  <a-row :gutter="16"><a-col :xs="24" :sm="12"><a-form-item :label="ct('PACK_REVISION')"><a-input :value="modelValue.packRevision" :maxlength="80" @update:value="set('packRevision', $event)" /></a-form-item></a-col>
  <a-col :xs="24" :sm="12"><a-form-item :label="ct('JAVA')"><a-select :value="modelValue.javaMajor" @update:value="set('javaMajor', $event)"><a-select-option :value="0">{{ct('JAVA_AUTO')}}</a-select-option><a-select-option v-for="v in [8, 11, 16, 17, 21, 25]" :key="v" :value="v">Java {{v}}</a-select-option></a-select></a-form-item></a-col></a-row>
  <a-row :gutter="16"><a-col :xs="24" :sm="12"><a-form-item :label="ct('MEMORY_MODE')"><a-select :value="modelValue.launch!.memoryMode" @update:value="launch('memoryMode', $event)"><a-select-option value="auto">{{ct('MEMORY_AUTO')}}</a-select-option><a-select-option value="manual">{{ct('MEMORY_MANUAL')}}</a-select-option></a-select></a-form-item></a-col>
  <a-col :xs="24" :sm="12"><a-form-item :label="ct('MEMORY')"><a-input-number :value="modelValue.memoryMb" :disabled="modelValue.launch!.memoryMode === 'auto'" :min="512" :max="262144" :step="512" style="width:100%" addon-after="MiB" @update:value="set('memoryMb', $event)" /></a-form-item></a-col></a-row>
  <a-form-item :label="ct('JAVA_RANGE')"><a-input :value="modelValue.launch!.javaRange" placeholder="[17, 22)" :maxlength="80" @update:value="launch('javaRange', $event)" /></a-form-item>
  <a-row :gutter="16"><a-col :xs="24" :sm="12"><a-form-item :label="ct('WINDOW_TITLE')"><a-input :value="modelValue.launch!.windowTitle" :maxlength="100" @update:value="launch('windowTitle', $event)" /></a-form-item></a-col>
  <a-col :xs="24" :sm="12"><a-form-item :label="ct('LAUNCHER_INFO')"><a-input :value="modelValue.launch!.launcherInfo" :maxlength="100" @update:value="launch('launcherInfo', $event)" /></a-form-item></a-col></a-row>
  <a-form-item :label="ct('WINDOW_MODE')"><a-select :value="modelValue.launch!.windowMode" @update:value="launch('windowMode', $event)"><a-select-option v-for="m in ['default','windowed','maximized','fullscreen']" :key="m" :value="m">{{ct('WINDOW_' + m)}}</a-select-option></a-select></a-form-item>
  <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('WINDOW_WIDTH')"><a-input-number :value="modelValue.launch!.width" :min="320" :max="16384" style="width:100%" @update:value="launch('width', $event)" /></a-form-item></a-col>
  <a-col :span="12"><a-form-item :label="ct('WINDOW_HEIGHT')"><a-input-number :value="modelValue.launch!.height" :min="240" :max="16384" style="width:100%" @update:value="launch('height', $event)" /></a-form-item></a-col></a-row>
  <a-form-item :label="ct('AUTO_JOIN')"><a-input :value="modelValue.launch!.autoJoin" placeholder="play.example.com:25565" :maxlength="255" @update:value="launch('autoJoin', $event)" /></a-form-item>
  <a-form-item :label="ct('JVM_ARGS')"><a-textarea :value="modelValue.launch!.jvmArgs" :rows="2" :maxlength="4000" placeholder="-XX:+UseG1GC" @update:value="launch('jvmArgs', $event)" /></a-form-item>
  <a-form-item :label="ct('GAME_ARGS')"><a-textarea :value="modelValue.launch!.gameArgs" :rows="2" :maxlength="4000" placeholder="--demo" @update:value="launch('gameArgs', $event)" /></a-form-item>
  <a-row :gutter="16"><a-col :span="12"><a-form-item :label="ct('GC')"><a-select :value="modelValue.launch!.gc" @update:value="launch('gc', $event)"><a-select-option v-for="v in ['default','serial','parallel','g1','zgc']" :key="v" :value="v">{{v}}</a-select-option></a-select></a-form-item></a-col>
  <a-col :span="12"><a-form-item :label="ct('DOWNLOAD_SOURCE')"><a-select :value="modelValue.launch!.downloadSource" @update:value="launch('downloadSource', $event)"><a-select-option v-for="v in ['auto','official','mirror']" :key="v" :value="v">{{ct('DOWNLOAD_' + v)}}</a-select-option></a-select></a-form-item></a-col></a-row>
  <a-space direction="vertical"><a-checkbox :checked="modelValue.launch!.memoryOptimization" @update:checked="launch('memoryOptimization', $event)">{{ct('MEMORY_OPTIMIZE')}}</a-checkbox>
  <a-checkbox :checked="modelValue.launch!.assets === 'verify'" @update:checked="launch('assets', $event ? 'verify' : 'default')">{{ct('VERIFY_ASSETS')}}</a-checkbox>
  <a-checkbox :checked="modelValue.launch!.disableJLW" @update:checked="launch('disableJLW', $event)">{{ct('DISABLE_JLW')}}</a-checkbox>
  <a-checkbox :checked="modelValue.launch!.disableLUA" @update:checked="launch('disableLUA', $event)">{{ct('DISABLE_LUA')}}</a-checkbox></a-space>
</template>
