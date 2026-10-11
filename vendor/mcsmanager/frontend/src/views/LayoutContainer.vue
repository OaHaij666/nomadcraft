<script setup lang="ts">
import LayoutCardComponent from "@/components/LayoutCard.vue";
import { getPageCards } from "@/config/pages";
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const cards = computed(() => getPageCards(route.path));
</script>

<template>
  <div class="main-layout-container">
    <a-row :gutter="[20, 20]">
      <a-col
        v-for="card in cards"
        :key="card.id"
        :span="24"
        :lg="card.width * 2"
        :data-card-type="card.type"
      >
        <LayoutCardComponent :card="card" :style="{ minHeight: card.height }" />
      </a-col>
    </a-row>
  </div>
</template>

<style scoped>
.main-layout-container {
  min-height: 100%;
  margin: auto;
  padding-bottom: 24px;
}
</style>
