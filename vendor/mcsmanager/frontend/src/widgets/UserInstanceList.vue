<script setup lang="ts">
import type { LayoutCard } from "@/types";
import WorldList from "./worlds/WorldList.vue";
defineProps<{ card: LayoutCard }>();
</script>
<template><WorldList :card="card" /></template>
