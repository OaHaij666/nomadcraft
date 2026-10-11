<script setup lang="ts">
import UploadBubble from "@/components/UploadBubble.vue";
import { useScreen } from "@/hooks/useScreen";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

import { Button, Input, Select, Table } from "ant-design-vue";
import { computed, onMounted } from "vue";
import { RouterView } from "vue-router";
import AppBottomNav from "./components/AppBottomNav.vue";
import AppConfigProvider from "./components/AppConfigProvider.vue";
import AppHeader from "./components/AppHeader.vue";
import AppSidebarMenu from "./components/AppSidebarMenu.vue";
import Breadcrumbs from "./components/Breadcrumbs.vue";
import InputDialogProvider from "./components/InputDialogProvider.vue";
import MyselfInfoDialog from "./components/MyselfInfoDialog.vue";
import { useAppStateStore } from "./stores/useAppStateStore";
import { closeAppLoading, setLoadingTitle } from "./tools/dom";

const { hasBgImage, initAppTheme, useSidebarLayout } = useAppConfigStore();
const { isLogged } = useAppStateStore();
const { isPhone } = useScreen();

const GLOBAL_COMPONENTS = [InputDialogProvider, MyselfInfoDialog, UploadBubble];

[Button, Select, Input, Table].forEach((element) => {
  element.props.size.default = "large";
});

const showNavigation = computed(() => isLogged.value);

onMounted(async () => {
  setLoadingTitle("Loading application settings...");
  await initAppTheme();
  closeAppLoading();
});
</script>

<template>
  <AppConfigProvider :has-bg-image="hasBgImage">
    <!-- App Container -->
    <div class="global-app-container">
      <AppSidebarMenu v-if="showNavigation && useSidebarLayout" />
      <main
        class="main-content"
        :class="{ 'app-layout-sidebar-only': showNavigation && useSidebarLayout }"
      >
        <AppHeader v-if="showNavigation && !useSidebarLayout" />
        <Breadcrumbs v-if="showNavigation" />
        <RouterView :key="$route.fullPath" />
      </main>
    </div>

    <!-- Mobile Bottom Navigation -->
    <AppBottomNav v-if="showNavigation && isPhone && !useSidebarLayout" />

    <!-- Global Components -->
    <component :is="component" v-for="(component, index) in GLOBAL_COMPONENTS" :key="index" />
  </AppConfigProvider>
</template>
