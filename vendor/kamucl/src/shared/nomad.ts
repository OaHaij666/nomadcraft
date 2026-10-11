import type { CloudSyncState } from './types'
export interface NomadStatus { address: string; connected: boolean; signedIn: boolean; username?: string }
export type NomadPermission =
  | 'instance.read'
  | 'instance.update'
  | 'save.create'
  | 'save.read'
  | 'save.update'
  | 'save.delete'
  | 'room.manage'
  | 'members.manage'
  | 'mods.manage'
  | 'players.manage'
export interface NomadCatalogProfile { mcVersion?: string; loader?: string; loaderVersion?: string; packName?: string; packRevision?: string }
export interface NomadCatalogSync { state?: CloudSyncState; localRevision?: number; cloudRevision?: number; message?: string }
export interface NomadCatalogSave { id: string; name: string; description?: string; rules?: Record<string, unknown>; players?: Array<Record<string, unknown>>; room?: { id?: string; name?: string; desiredState?: 'open' | 'closed'; createdAt?: number } | null; hosting?: { joinAddress?: string | null; phase?: string; nodeName?: string } | null; hostingAllowed?: boolean; sync?: NomadCatalogSync }
export interface NomadCatalogInstance {
  id: string
  name: string
  description?: string
  ownerId?: string
  ownerName?: string
  profile?: NomadCatalogProfile
  saves?: NomadCatalogSave[]
  permissions?: NomadPermission[]
  savePermissions?: Record<string, NomadPermission[]>
  grants?: Array<{ userId: string; scope: string; permissions: NomadPermission[]; hosting?: boolean }>
  mods?: NomadModEntry[]
  revision?: number
  sync?: NomadCatalogSync
}
export interface NomadCatalog { instances: NomadCatalogInstance[]; canCreate?: boolean; fetchedAt: number }
export interface NomadModEntry { name: string; version: string; file: string; sha256: string; side: 'server' | 'both' }
