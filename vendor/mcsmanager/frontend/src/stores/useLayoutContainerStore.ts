import { createGlobalState } from "@vueuse/core";
import { reactive } from "vue";

export const useLayoutContainerStore = createGlobalState(() => ({
  containerState: reactive({ showPhoneMenu: false })
}));
