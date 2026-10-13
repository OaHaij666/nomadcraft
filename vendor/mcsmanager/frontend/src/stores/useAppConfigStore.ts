/* eslint-disable no-unused-vars */
import { getCurrentLang, setLanguage } from "@/lang/i18n";
import { AppTheme, THEME_KEY } from "@/types/const";
import { createGlobalState, useBreakpoints, useLocalStorage, usePreferredDark } from "@vueuse/core";
import { theme as antTheme } from "ant-design-vue";
import type { ThemeConfig } from "ant-design-vue/es/config-provider/context";
import { computed, reactive, ref, watch } from "vue";

export const useAppConfigStore = createGlobalState(() => {
  const isPreferredDark = usePreferredDark();

  // Shared tokens for both themes. The palette lives in assets/nomad-theme.scss;
  // these values mirror it so Ant's components agree with our own CSS instead of
  // fighting it. See docs/design/前端设计语言-v1.md.
  const sharedTokens = {
    fontFamily: '"IBM Plex Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontFamilyCode: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 6,
    fontSizeLG: 14,
    fontSizeSM: 12,
    fontSizeXL: 18,
    // Motion stays short; the product never animates for its own sake.
    motionDurationMid: "0.16s",
    motionDurationSlow: "0.24s"
  };

  const theme: ThemeConfig = reactive({
    algorithm: antTheme.defaultAlgorithm,
    token: {
      ...sharedTokens,
      colorPrimary: "#3f7f78",
      colorInfo: "#3f7f78",
      colorError: "#b06a3d",
      colorWarning: "#b06a3d"
    }
  });

  // The product's signature look is the night sky, so dark is the default.
  const currentTheme = useLocalStorage<AppTheme>(THEME_KEY, AppTheme.DARK);

  const isDarkTheme = computed(() => {
    if (currentTheme.value === AppTheme.DARK) return true;
    if (currentTheme.value === AppTheme.AUTO) return isPreferredDark.value;
    return false;
  });

  const hasBgImage = ref(false);

  // Desktop uses a fixed sidebar; narrower screens use the header.
  const breakpoints = useBreakpoints({ sidebar: 1400 });
  const isWideEnoughForSidebar = breakpoints.greaterOrEqual("sidebar");
  const useSidebarLayout = isWideEnoughForSidebar;

  const setLight = () => {
    theme.algorithm = antTheme.defaultAlgorithm;
    theme.token = {
      ...sharedTokens,
      colorPrimary: "#3f7f78",
      colorInfo: "#3f7f78",
      colorError: "#b06a3d",
      colorWarning: "#b06a3d"
    };
    document.body.classList.add("app-light-theme");
    document.body.classList.remove("app-dark-theme");
  };

  const setDark = () => {
    theme.algorithm = antTheme.darkAlgorithm;
    // In the dark theme aurora becomes the action colour: it has enough contrast
    // against our dusk surfaces, and it keeps one accent through the product.
    theme.token = {
      ...sharedTokens,
      colorPrimary: "#7ad4c8",
      colorInfo: "#7ad4c8",
      colorError: "#e8894f",
      colorWarning: "#e8894f"
    };
    document.body.classList.add("app-dark-theme");
    document.body.classList.remove("app-light-theme");
  };

  const resetTheme = () => (currentTheme.value = AppTheme.LIGHT);

  const initAppTheme = async () => {
    if (
      isNaN(currentTheme.value) ||
      currentTheme.value < AppTheme.AUTO ||
      currentTheme.value > AppTheme.DARK
    ) {
      resetTheme();
    }
    const fn = {
      [AppTheme.AUTO]: () => (isPreferredDark.value ? setDark() : setLight()),
      [AppTheme.LIGHT]: () => setLight(),
      [AppTheme.DARK]: () => setDark()
    };
    fn[currentTheme.value]?.();
  };

  const setTheme = (t: AppTheme) => {
    currentTheme.value = t;
    initAppTheme();
  };

  const changeLanguage = (lang: string) => {
    setLanguage(lang);
  };

  const getCurrentLanguage = () => {
    return getCurrentLang() ?? "en_us";
  };

  watch(isPreferredDark, () => {
    if (currentTheme.value === AppTheme.AUTO) {
      initAppTheme();
    }
  });

  return {
    hasBgImage,
    useSidebarLayout,
    changeLanguage,
    getCurrentLanguage,
    isDarkTheme,
    initAppTheme,
    setTheme,
    currentTheme,
    themeConfig: theme
  };
});
