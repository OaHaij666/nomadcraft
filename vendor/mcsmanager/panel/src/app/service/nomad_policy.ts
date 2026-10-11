import { systemConfig } from "../setting";
export const DEFAULT_PACKAGE_UPLOAD_GIB = 5;
export function validUploadGiB(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 1024;
}
export function uploadPolicy() {
  const value = systemConfig?.nomadPackageUploadGiB;
  const maxGiB = validUploadGiB(value) ? value : DEFAULT_PACKAGE_UPLOAD_GIB;
  return {maxGiB, maxBytes: Math.floor(maxGiB * 1024 ** 3), maxExpandedBytes: Math.floor(maxGiB * 4 * 1024 ** 3)};
}
