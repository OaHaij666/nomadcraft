<script setup lang="ts">
import { ref, watch } from "vue";
import { cloneDeep } from "lodash";
import { ct } from "@/hooks/useCatalog";
import type { PlayerRule } from "@/services/apis/catalog";
const props = defineProps<{ initial: PlayerRule[]; editable: boolean; busy: boolean }>();
const emit = defineEmits<{ submit: [players: PlayerRule[]] }>();
const players = ref<PlayerRule[]>(cloneDeep(props.initial));
watch(
  () => props.initial,
  () => {
    players.value = cloneDeep(props.initial);
  }
);
</script>
<template>
  <div>
    <div class="section-heading">
      <div>
        <h2>{{ ct("PLAYERS") }}</h2>
        <p>{{ ct("PLAYERS_NOTE") }}</p>
      </div>
      <a-button
        v-if="editable"
        @click="players.push({ uuid: '', name: '', access: 'allowed', opLevel: 0 })"
        >+ {{ ct("ADD_PLAYER") }}</a-button
      >
    </div>
    <a-empty v-if="!players.length" :description="ct('NO_PLAYER_RULES')" />
    <div v-for="(player, index) in players" :key="index" class="player-row">
      <a-row :gutter="12"
        ><a-col :xs="24" :md="6"
          ><label>{{ ct("PLAYER_NAME") }}</label
          ><a-input v-model:value="player.name" :disabled="!editable" :maxlength="16" /></a-col
        ><a-col :xs="24" :md="9"
          ><label>UUID</label
          ><a-input v-model:value="player.uuid" :disabled="!editable" :maxlength="36" /></a-col
        ><a-col :xs="12" :md="5"
          ><label>{{ ct("PLAYER_ACCESS") }}</label
          ><a-select
            v-model:value="player.access"
            style="width: 100%"
            :disabled="!editable"
            @change="player.access === 'banned' && (player.opLevel = 0)"
            ><a-select-option value="allowed">{{ ct("PLAYER_ALLOWED") }}</a-select-option
            ><a-select-option value="banned">{{ ct("PLAYER_BANNED") }}</a-select-option></a-select
          ></a-col
        ><a-col :xs="12" :md="4"
          ><label>{{ ct("OP_LEVEL") }}</label
          ><a-input-number
            v-model:value="player.opLevel"
            :min="0"
            :max="4"
            :disabled="!editable || player.access === 'banned'" /></a-col></a-row
      ><a-button
        v-if="editable"
        type="text"
        danger
        class="mt-10"
        @click="players.splice(index, 1)"
        >{{ ct("REMOVE") }}</a-button
      >
    </div>
    <a-button v-if="editable" type="primary" :loading="busy" @click="emit('submit', players)">{{
      ct("SAVE_PLAYER_POLICY")
    }}</a-button>
    <p class="policy-note">{{ ct("PLAYER_POLICY_PENDING") }}</p>
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
.player-row {
  padding: 20px;
  border: var(--nc-hairline);
  border-radius: 10px;
  margin-bottom: 16px;
}
.player-row label {
  display: block;
  color: var(--nc-mist);
  font-size: 12px;
  margin-bottom: 8px;
}
.policy-note {
  margin-top: 20px;
}
</style>
