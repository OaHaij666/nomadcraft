import { initI18n } from "@/lang/i18n";
import { useAppStateStore } from "./stores/useAppStateStore";
import { setAppLoadingError, setLoadingTitle } from "./tools/dom";
import { AppTheme, THEME_KEY } from "./types/const";
import { isAppMode } from "./utils/appMode";

function handleLoadingError(error: any) {
  console.error("Init app error:", error);
  const errorMessage = String(error?.message || error);
  if (errorMessage.toLowerCase().includes("request failed with status code 500")) {
    setAppLoadingError("The backend is currently unavailable, please try again later.");
    return;
  }
  setAppLoadingError(errorMessage);
}

function applyAppModeTheme() {
  if (isAppMode()) {
    localStorage.setItem(THEME_KEY, String(AppTheme.DARK));
  }
}

function embeddedSessionToken(): string {
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
  const query = new URLSearchParams(hashQuery || window.location.search.slice(1));
  return query.get('nomadToken') || '';
}

async function initApp() {
  try {
    applyAppModeTheme();
    const { state, updatePanelStatus } = useAppStateStore();
    const token = embeddedSessionToken();
    if (token) state.userInfo = { token } as any;
    setLoadingTitle("Initializing Application...");
    await updatePanelStatus();
    setLoadingTitle("Initializing Language...");
    await initI18n(state.language);
    document.title = "NomadCraft";
    setLoadingTitle("Downloading JavaScript Files...");
    const module = await import("./mount");
    setLoadingTitle("Rendering Application...");
    await module.mountApp();
  } catch (error: any) {
    handleLoadingError(error);
  }
}

initApp();
