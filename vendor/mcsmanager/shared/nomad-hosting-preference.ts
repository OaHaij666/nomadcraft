export const HOSTING_WILLINGNESS = ["high", "medium", "low", "none"] as const;
export type HostingWillingness = (typeof HOSTING_WILLINGNESS)[number];
export const DEFAULT_HOSTING_WILLINGNESS: HostingWillingness = "medium";
export function isHostingWillingness(value: unknown): value is HostingWillingness {
  return typeof value === "string" && (HOSTING_WILLINGNESS as readonly string[]).includes(value);
}
export interface HostingPreference {
  hostingWillingness: HostingWillingness;
}
