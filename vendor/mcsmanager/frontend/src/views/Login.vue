<script setup lang="ts">
import LoginCard from "@/widgets/LoginCard.vue";
</script>

<template>
  <div class="auth-page">
    <div class="auth-card"><LoginCard /></div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 85vh;
  display: grid;
  place-items: center;
  padding: 32px 16px;
}
.auth-card {
  width: 100%;
  max-width: 430px;
}
</style>
