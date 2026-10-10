<script setup lang="ts">
import type { LayoutCard } from "@/types";
import LoginCard from "@/widgets/LoginCard.vue";
import { useScreen } from "../hooks/useScreen";
import LayoutContainer from "./LayoutContainer.vue";

defineProps<{
  card: LayoutCard;
}>();

const { isPhone } = useScreen();

const skeletonConfigs = [
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 24, rows: 9 },
  { span: 8, rows: 6 },
  { span: 16, rows: 6 },
  { span: 8, rows: 6 },
  { span: 16, rows: 6 }
];
</script>

<template>
  <div v-if="!isPhone">
    <div class="main-layout-container">
      <a-row :gutter="[24, 24]">
        <a-col v-for="(config, index) in skeletonConfigs" :key="index" :span="config.span">
          <CardPanel>
            <template #body>
              <a-skeleton :paragraph="{ rows: config.rows }" />
            </template>
          </CardPanel>
        </a-col>
      </a-row>
    </div>
    <div class="login-page-container">
      <div class="login-page-body">
        <LayoutContainer></LayoutContainer>
      </div>
    </div>
  </div>
  <div v-else>
    <LoginCard></LoginCard>
  </div>
</template>

<style></style>

<style lang="scss">
@import "@/assets/nomad-theme.scss";

// The login backdrop: the night sky the product is named for, rendered with two
// flat tonal stops and a hairline. Deliberately no blur, no vignette, no glow —
// chrome here would compete with the wordmark.
.login-page-container {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(
      120% 80% at 50% 0%,
      var(--nc-dusk) 0%,
      var(--nc-ink) 62%
    ),
    var(--nc-ink);
  overflow-y: auto;
  overflow-x: hidden;

  .login-page-body {
    padding: 12px;
    padding-top: 84px;
    max-width: 1260px !important;
    margin: 0 auto;
    height: 100%;
    position: relative;

    .main-flex-center {
      margin-top: 0 !important;
      position: absolute;
      inset: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      text-align: left !important;
    }
  }
}
</style>
