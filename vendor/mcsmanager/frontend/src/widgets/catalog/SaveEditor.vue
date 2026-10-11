<script setup lang="ts">
import { ref } from "vue";
import { cloneDeep } from "lodash";
import { ct } from "@/hooks/useCatalog";
import { DEFAULT_RULES, type SaveInput } from "@/services/apis/catalog";
const props = defineProps<{ initial?: SaveInput; busy?: boolean }>();
const emit = defineEmits<{ submit: [data: SaveInput] }>();
const form = ref<SaveInput>(
  cloneDeep(props.initial ?? { name: "", description: "", rules: DEFAULT_RULES })
);
</script>
<template>
  <a-form :model="form" layout="vertical" @finish="emit('submit', form)">
    <a-form-item
      :label="ct('SAVE_NAME')"
      name="name"
      :rules="[{ required: true, whitespace: true, message: ct('REQUIRED') }]"
      ><a-input v-model:value="form.name" :maxlength="120"
    /></a-form-item>
    <a-form-item :label="ct('SEED')" :name="['rules', 'seed']"
      ><a-input v-model:value="form.rules.seed" :disabled="!!initial" :maxlength="128"
    /></a-form-item>
    <a-row :gutter="16"
      ><a-col :span="12"
        ><a-form-item :label="ct('GAME_MODE')" :name="['rules', 'gameMode']"
          ><a-select v-model:value="form.rules.gameMode"
            ><a-select-option
              v-for="mode in ['survival', 'creative', 'adventure', 'spectator']"
              :key="mode"
              :value="mode"
              >{{ ct("MODE_" + mode) }}</a-select-option
            ></a-select
          ></a-form-item
        ></a-col
      ><a-col :span="12"
        ><a-form-item :label="ct('DIFFICULTY')" :name="['rules', 'difficulty']"
          ><a-select v-model:value="form.rules.difficulty"
            ><a-select-option
              v-for="difficulty in ['peaceful', 'easy', 'normal', 'hard']"
              :key="difficulty"
              :value="difficulty"
              >{{ ct("DIFFICULTY_" + difficulty) }}</a-select-option
            ></a-select
          ></a-form-item
        ></a-col
      ></a-row
    >
    <a-row :gutter="16"
      ><a-col :span="8"
        ><a-form-item :label="ct('MAX_PLAYERS')" :name="['rules', 'maxPlayers']"
          ><a-input-number
            v-model:value="form.rules.maxPlayers"
            :min="1"
            :max="1000" /></a-form-item></a-col
      ><a-col :span="8"
        ><a-form-item :label="ct('VIEW_DISTANCE')" :name="['rules', 'viewDistance']"
          ><a-input-number
            v-model:value="form.rules.viewDistance"
            :min="3"
            :max="32" /></a-form-item></a-col
      ><a-col :span="8"
        ><a-form-item :label="ct('SIMULATION_DISTANCE')" :name="['rules', 'simulationDistance']"
          ><a-input-number
            v-model:value="form.rules.simulationDistance"
            :min="3"
            :max="32" /></a-form-item></a-col
    ></a-row>
    <a-row :gutter="16"
      ><a-col :span="8"
        ><a-form-item :label="ct('PVP')" :name="['rules', 'pvp']"
          ><a-switch v-model:checked="form.rules.pvp" /></a-form-item></a-col
      ><a-col :span="8"
        ><a-form-item :label="ct('HARDCORE')" :name="['rules', 'hardcore']"
          ><a-switch v-model:checked="form.rules.hardcore" /></a-form-item></a-col
      ><a-col :span="8"
        ><a-form-item :label="ct('WHITELIST')" :name="['rules', 'whitelist']"
          ><a-switch v-model:checked="form.rules.whitelist" /></a-form-item></a-col
    ></a-row>
    <a-form-item :label="ct('DESCRIPTION')" name="description"
      ><a-textarea v-model:value="form.description" :rows="2" :maxlength="2000"
    /></a-form-item>
    <p class="form-note">{{ ct("SAVE_CREATE_NOTE") }}</p>
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
