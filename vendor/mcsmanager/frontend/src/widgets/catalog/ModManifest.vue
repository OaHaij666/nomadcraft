<script setup lang="ts">
import { ref, watch } from "vue";
import { cloneDeep } from "lodash";
import { ct } from "@/hooks/useCatalog";
import type { ModEntry } from "@/services/apis/catalog";
const props = defineProps<{ initial: ModEntry[]; editable: boolean; busy: boolean }>();
const emit = defineEmits<{ submit: [mods: ModEntry[]] }>();
const mods = ref<ModEntry[]>(cloneDeep(props.initial));
watch(
  () => props.initial,
  () => {
    mods.value = cloneDeep(props.initial);
  }
);
const add = () => mods.value.push({ name: "", version: "", file: "", sha256: "", side: "server" });
</script>
<template>
  <div>
    <div class="section-heading">
      <div>
        <h2>{{ ct("MODS") }}</h2>
        <p>{{ ct("MODS_NOTE") }}</p>
      </div>
      <a-button v-if="editable" @click="add">+ {{ ct("ADD_MOD") }}</a-button>
    </div>
    <a-empty v-if="!mods.length" :description="ct('NO_MODS')" />
    <div v-for="(mod, index) in mods" :key="index" class="mod-row">
      <a-row :gutter="12"
        ><a-col :xs="24" :md="8"
          ><label>{{ ct("MOD_NAME") }}</label
          ><a-input v-model:value="mod.name" :disabled="!editable" /></a-col
        ><a-col :xs="12" :md="4"
          ><label>{{ ct("MOD_VERSION") }}</label
          ><a-input v-model:value="mod.version" :disabled="!editable" /></a-col
        ><a-col :xs="12" :md="5"
          ><label>{{ ct("MOD_SIDE") }}</label
          ><a-select v-model:value="mod.side" :disabled="!editable" style="width: 100%"
            ><a-select-option value="server">{{ ct("SIDE_server") }}</a-select-option
            ><a-select-option value="both">{{ ct("SIDE_both") }}</a-select-option></a-select
          ></a-col
        ><a-col :xs="24" :md="7"
          ><label>{{ ct("MOD_FILE") }}</label
          ><a-input
            v-model:value="mod.file"
            :disabled="!editable"
            placeholder="example.jar" /></a-col
      ></a-row>
      <div class="mod-hash">
        <a-input
          v-model:value="mod.sha256"
          :disabled="!editable"
          :placeholder="ct('HASH')"
          :maxlength="64"
        /><a-button v-if="editable" type="text" danger @click="mods.splice(index, 1)">{{
          ct("REMOVE")
        }}</a-button>
      </div>
    </div>
    <a-button
      v-if="editable"
      type="primary"
      :loading="busy"
      :disabled="mods.some((m) => !m.name.trim() || !m.file.trim())"
      @click="emit('submit', mods)"
      >{{ ct("SAVE_MANIFEST") }}</a-button
    >
    <p class="policy-note">{{ ct("MANIFEST_PENDING") }}</p>
  </div>
</template>
<style scoped>
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
.mod-row {
  padding: 20px;
  border: var(--nc-hairline);
  border-radius: 10px;
  margin-bottom: 16px;
}
.mod-row label {
  display: block;
  color: var(--nc-mist);
  font-size: 12px;
  margin-bottom: 8px;
}
.mod-hash {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}
.policy-note {
  margin-top: 20px;
}
</style>
