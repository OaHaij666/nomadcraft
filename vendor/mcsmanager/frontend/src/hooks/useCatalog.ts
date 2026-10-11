import { computed, ref } from "vue";
import { t } from "@/lang/i18n";
import {
  catalogApi,
  type CatalogPermission,
  type CatalogResponse,
  type InstanceView
} from "@/services/apis/catalog";
import { message } from "ant-design-vue";
export const ct = (key: string, params?: Record<string, unknown>) =>
  t("TXT_CODE_CATALOG_" + key, params);
export function catalogError(error: unknown): string {
  const code = (error as any)?.response?.data?.data ?? (error as any)?.message ?? "request_failed";
  const known = [
    "invalid_package",
    "unsafe_package_path",
    "unsupported_package",
    "unsupported_loader",
    "package_too_large",
    "unsafe_download_url",
    "release_not_found",
    "release_limit",
    "package_not_found",
    "official_unavailable",
    "invalid_official_version",
    "upload_busy",
    "component_source_unavailable",
    "component_version_unavailable",
    "invalid_install_selection",
    "incompatible_components",
    "optifabric_required",
    "eula_required",
    "server_version_unavailable",
    "java_version_too_old",
    "unsafe_launch_arguments",
    "invalid_server_address",
    "invalid_upload_limit",
    "server_checksum_failed",
    "hosting_forbidden",
    "room_not_open",
    "vanilla_server_required",
    "host_busy",
    "host_must_stop_first",
    "final_checkpoint_required",
    "executor_authentication_required",
    "executor_expired",
    "stale_host_epoch",
    "invalid_world_archive",
    "world_level_missing",
    "world_snapshot_missing",
    "executor_limit",
    "forbidden",
    "authentication_required",
    "create_forbidden",
    "owner_required",
    "version_locked",
    "seed_locked",
    "close_rooms_first",
    "room_exists",
    "instance_has_saves",
    "unknown_user",
    "unknown_scope",
    "invalid_scope",
    "invalid_hash",
    "invalid_player_uuid",
    "invalid_mod_file",
    "required_field",
    "invalid_number",
    "invalid_boolean",
    "invalid_choice",
    "read_permission_required",
    "owner_only_permission",
    "duplicate_grant",
    "banned_operator",
    "invalid_text",
    "invalid_list",
    "invalid_object",
    "instance_not_found",
    "save_not_found",
    "room_not_found"
  ];
  return known.includes(String(code)) ? ct("ERROR_" + code) : ct("ERROR_request_failed");
}
export function can(
  instance: InstanceView,
  permission: CatalogPermission,
  saveId?: string
): boolean {
  return (saveId ? instance.savePermissions[saveId] ?? [] : instance.permissions).includes(
    permission
  );
}
export function useCatalog() {
  const data = ref<CatalogResponse>({ instances: [], canCreate: false });
  const loading = ref(false);
  const error = ref("");
  const busy = ref(false);
  const reload = async () => {
    loading.value = true;
    error.value = "";
    try {
      data.value = await catalogApi.list();
    } catch (e) {
      data.value = { instances: [], canCreate: false };
      error.value = catalogError(e);
    } finally {
      loading.value = false;
    }
  };
  const mutate = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (busy.value) return false;
    busy.value = true;
    try {
      await operation();
      await reload();
      message.success(ct("SAVED"));
      return true;
    } catch (e) {
      message.error(catalogError(e));
      return false;
    } finally {
      busy.value = false;
    }
  };
  return {
    data,
    loading,
    error,
    busy,
    reload,
    mutate,
    instances: computed(() => data.value.instances)
  };
}
