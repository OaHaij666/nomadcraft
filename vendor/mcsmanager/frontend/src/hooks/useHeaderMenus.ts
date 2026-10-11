import { router, type RouterMetaInfo } from "@/config/router";
import { useAppRouters } from "@/hooks/useAppRouters";
import { t } from "@/lang/i18n";
import { logoutUser } from "@/services/apis/index";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { useAppToolsStore } from "@/stores/useAppToolsStore";
import { useLayoutContainerStore } from "@/stores/useLayoutContainerStore";
import { AppTheme } from "@/types/const";
import { BgColorsOutlined, LogoutOutlined, UserOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import type { Component } from "vue";
import { computed } from "vue";

/** Sidebar item: divider */
export type SidebarDividerEntry = { type: "divider" };

/** Sidebar item: route link */
export type SidebarRouteEntry = {
  type: "route";
  path: string;
  name: string | symbol | undefined;
  customClass?: string[];
};

/** Sidebar item: app menu (no submenu) */
export type SidebarAppEntry = {
  type: "app";
  title: string;
  icon?: Component;
  customClass?: string[];
  click: () => void;
};

/** Sidebar item: app menu with dropdown */
export type SidebarAppDropdownEntry = {
  type: "app-dropdown";
  title: string;
  icon?: Component;
  customClass?: string[];
  menus: { value: string | number; title: string }[];
  // Param name for type semantics only; overlay passes key
  // eslint-disable-next-line no-unused-vars -- type param name
  click: (menuKey: string) => void;
};

export type SidebarEntry =
  | SidebarDividerEntry
  | SidebarRouteEntry
  | SidebarAppEntry
  | SidebarAppDropdownEntry;

export function useHeaderMenus() {
  const { containerState } = useLayoutContainerStore();
  const { toPage } = useAppRouters();
  const { setTheme } = useAppConfigStore();
  const { state: appTools } = useAppToolsStore();
  const { isAdmin, state: appState, isLogged } = useAppStateStore();
  const { execute } = logoutUser();

  const handleToPage = (url: string) => {
    containerState.showPhoneMenu = false;
    toPage({ path: url });
  };

  const menus = computed(() => {
    return router
      .getRoutes()
      .filter((v) => {
        if (v.path === "/" || !v.name) return false;
        const metaInfo = v.meta as RouterMetaInfo;
        if (metaInfo.condition && !metaInfo.condition()) {
          return false;
        }
        if (isAdmin.value) {
          return metaInfo.mainMenu === true && v.path !== "/customer";
        }
        return (
          metaInfo.mainMenu === true &&
          isLogged.value &&
          Number(appState.userInfo?.permission) >= Number(metaInfo.permission)
        );
      })
      .map((r) => ({
        name: r.name,
        path: r.path,
        meta: r.meta,
        customClass: r.meta.customClass ?? []
      }));
  });

  // The header actions are deliberately few: theme, account, sign out. The old
  // layout customiser (add card / save / reset / edit mode) is gone — pages are
  // now designed, not assembled by the user.
  const appMenus = computed(() => {
    return [
      {
        conditions: true,
        title: t("TXT_CODE_5d88a9b"),
        leftSideTitle: t("TXT_CODE_ee01c10c"),
        icon: BgColorsOutlined,
        click: (key: string) => {
          setTheme(Number(key) as AppTheme);
        },
        onlyPC: false,
        menus: [
          { value: AppTheme.AUTO, title: t("TXT_CODE_dc8de4ff") },
          { value: AppTheme.LIGHT, title: t("TXT_CODE_673eac8e") },
          { value: AppTheme.DARK, title: t("TXT_CODE_5e4a370d") }
        ]
      },
      {
        title: t("TXT_CODE_8c3164c9"),
        icon: UserOutlined,
        click: (): void => {
          appTools.showUserInfoDialog = true;
        },
        conditions: isLogged.value,
        onlyPC: false
      },
      {
        title: t("TXT_CODE_2c69ab15"),
        icon: LogoutOutlined,
        click: async (): Promise<void> => {
          Modal.confirm({
            title: t("TXT_CODE_9654b91c"),
            async onOk() {
              await execute();
              message.success(t("TXT_CODE_11673d8c"));
              setTimeout(() => (window.location.href = "/"), 400);
            }
          });
        },
        customClass: ["nav-button-danger"],
        conditions: isLogged.value,
        onlyPC: false
      }
    ];
  });

  /** Sidebar config: route menu + divider + app menu, rendered in one loop */
  const sidebarItems = computed((): SidebarEntry[] => {
    const routeEntries: SidebarRouteEntry[] = menus.value.map((r) => ({
      type: "route",
      path: r.path,
      name: r.name,
      customClass: Array.isArray(r.customClass) ? r.customClass : []
    }));
    const divider: SidebarDividerEntry = { type: "divider" };
    const appEntries: (SidebarAppEntry | SidebarAppDropdownEntry)[] = appMenus.value
      .filter((item) => item.conditions)
      .map((item) => {
        if (item.menus && item.menus.length > 0) {
          return {
            type: "app-dropdown" as const,
            title: item.leftSideTitle || item.title,
            icon: item.icon,
            customClass: item.customClass,
            menus: item.menus,
            click: item.click as (_: string) => void
          };
        }
        return {
          type: "app" as const,
          title: item.leftSideTitle || item.title,
          icon: item.icon,
          customClass: item.customClass,
          click: item.click as () => void
        };
      });
    return [...routeEntries, divider, ...appEntries];
  });

  return { menus, appMenus, sidebarItems, handleToPage };
}
