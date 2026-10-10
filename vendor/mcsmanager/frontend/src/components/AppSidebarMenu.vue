<script setup lang="ts">
import {
  useHeaderMenus,
  type SidebarAppDropdownEntry,
  type SidebarEntry
} from "@/hooks/useHeaderMenus";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import {
  ApartmentOutlined,
  AppstoreOutlined,
  AreaChartOutlined,
  LinkOutlined,
  LoginOutlined,
  MenuOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
  UserOutlined
} from "@ant-design/icons-vue";
import type { Key } from "ant-design-vue/es/table/interface";
import type { Component } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const { sidebarItems, handleToPage } = useHeaderMenus();
const { logoImage } = useAppConfigStore();

/** Whether route menu item is active (current path equals or is child of this path) */
const isRouteActive = (path: string): boolean => {
  if (route.path === path) return true;
  if (path === "/") return false;
  return route.path.startsWith(path + "/");
};

/** Sidebar icon for each route path */
const routePathIcons: Record<string, Component> = {
  "/instances": AppstoreOutlined,
  "/market": ShopOutlined,
  "/overview": AreaChartOutlined,
  "/users": TeamOutlined,
  "/node": ApartmentOutlined,
  "/settings": SettingOutlined,
  "/customer": UserOutlined,
  "/login": LoginOutlined,
  "/_open_page": LinkOutlined
};

const getRouteIcon = (path: string): Component => {
  return routePathIcons[path] ?? MenuOutlined;
};

const getItemKey = (entry: SidebarEntry, index: number): string => {
  if (entry.type === "divider") return "sidebar-divider";
  if (entry.type === "route") return entry.path;
  return `app-${index}-${entry.title}`;
};

const onAppDropdownClick = (item: SidebarAppDropdownEntry, info: { key: Key }) => {
  item.click(String(info.key));
};
</script>

<template>
  <aside class="left-sidebar">
    <a href="." class="logo">
      <img :src="logoImage" />
    </a>
    <nav class="sidebar-menu">
      <template v-for="(entry, index) in sidebarItems" :key="getItemKey(entry, index)">
        <!-- Divider -->
        <div v-if="entry.type === 'divider'" class="sidebar-divider" />

        <!-- Route link -->
        <a
          v-else-if="entry.type === 'route'"
          class="sidebar-item"
          :class="[entry.customClass, { 'sidebar-item-active': isRouteActive(entry.path) }]"
          @click.prevent="handleToPage(entry.path)"
        >
          <component :is="getRouteIcon(entry.path)" class="sidebar-item-icon" />
          <span class="sidebar-item-text">{{ entry.name }}</span>
        </a>

        <!-- App menu (dropdown) -->
        <a-dropdown v-else-if="entry.type === 'app-dropdown'" trigger="click" placement="topRight">
          <a class="sidebar-item" @click.prevent>
            <component :is="entry.icon" v-if="entry.icon" class="sidebar-item-icon" />
            <span class="sidebar-item-text">{{ entry.title }}</span>
          </a>
          <template #overlay>
            <a-menu @click="(info) => onAppDropdownClick(entry, info)">
              <a-menu-item v-for="m in entry.menus" :key="String(m.value)">
                {{ m.title }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>

        <!-- App menu (single click) -->
        <a
          v-else-if="entry.type === 'app'"
          class="sidebar-item"
          :class="entry.customClass"
          @click.prevent="entry.click()"
        >
          <component :is="entry.icon" v-if="entry.icon" class="sidebar-item-icon" />
          <span class="sidebar-item-text">{{ entry.title }}</span>
        </a>
      </template>
    </nav>
  </aside>
</template>

<style lang="scss" scoped>
@import "@/assets/nomad-theme.scss";

// The rail is the product's spine. It stays quiet: no background image, no
// gradient, no glow. Hierarchy comes from the ink/dusk ramp and one aurora rail
// marking where you are.

.logo {
  display: block;
  padding: 4px 12px 22px;

  img {
    height: 22px;
    animation: nc-logo-settle 9s ease infinite;
  }
}

.left-sidebar {
  display: flex;
  flex-direction: column;
  flex: 0 0 232px;
  width: 232px;
  text-align: left;
  padding: 22px 14px 18px;
  background: var(--nc-ink);
  border-right: var(--nc-hairline);
  transition: width var(--nc-dur) var(--nc-ease);
  position: relative;

  // A hairline of dusk light along the outer edge: the horizon of the night sky.
  &::after {
    content: "";
    position: absolute;
    inset: 0 0 0 auto;
    width: 1px;
    background: linear-gradient(
      to bottom,
      transparent,
      var(--nc-haze) 18%,
      var(--nc-haze) 82%,
      transparent
    );
  }
}

.left-sidebar:hover {
  width: 246px;
}

.sidebar-menu {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 0;
  flex: 1;
  gap: 2px;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}

.sidebar-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  color: var(--nc-mist);
  text-decoration: none;
  cursor: pointer;
  border-radius: var(--nc-radius-sm);
  transition:
    background-color var(--nc-dur-fast) var(--nc-ease),
    color var(--nc-dur-fast) var(--nc-ease);
  width: 100%;
  font-size: 14px;
  font-weight: 500;

  &:hover {
    background-color: var(--nc-dusk);
    color: var(--nc-parchment);
  }

  // Active state is a rail, not a filled pill: quieter and more legible.
  &.sidebar-item-active {
    color: var(--nc-parchment);
    background-color: var(--nc-dusk);

    &::before {
      content: "";
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 2px;
      height: 18px;
      border-radius: 2px;
      background: var(--nc-aurora);
    }
  }

  .sidebar-item-icon {
    font-size: 16px;
    flex-shrink: 0;
    opacity: 0.9;
  }

  .sidebar-item-text {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.sidebar-divider {
  height: 1px;
  background-color: var(--nc-haze);
  margin: 10px 4px;
  flex-shrink: 0;
  opacity: 0.6;
}

// Semantic highlight hooks inherited from the menu hook, re-tinted to the two
// semantic colours only.
:deep(.nav-button-warning:hover) {
  background-color: rgba(232, 137, 79, 0.12) !important;
  color: var(--nc-ember) !important;
}

:deep(.nav-button-success:hover) {
  background-color: rgba(122, 212, 200, 0.1) !important;
  color: var(--nc-aurora) !important;
}

:deep(.nav-button-danger:hover) {
  background-color: rgba(232, 137, 79, 0.16) !important;
  color: var(--nc-ember) !important;
}

@keyframes nc-logo-settle {
  0%,
  88%,
  100% {
    transform: rotate(0deg);
  }
  92% {
    transform: rotate(3deg);
  }
  96% {
    transform: rotate(-2deg);
  }
}
</style>
