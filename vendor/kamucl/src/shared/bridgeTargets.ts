export interface PlayerBridgeTarget { loader?: string; mcVersion: string }
/** Resolve the actual runtime before copying a jar: Forge and NeoForge cannot load the Fabric entrypoint. */
export function playerBridgeArtifact(profile: PlayerBridgeTarget): string {
  if (profile.loader === 'fabric') return 'kamucl-bridge.jar'
  if (profile.loader === 'forge' && profile.mcVersion === '1.20.1') return 'kamucl-bridge-forge-1.20.1-1.0.1.jar'
  if (profile.loader === 'neoforge' && profile.mcVersion === '1.21.1') return 'kamucl-bridge-neoforge-1.21.1-1.0.1.jar'
  throw new Error('玩家命令桥接支持 Fabric 1.20 及以上、Forge 1.20.1 和 NeoForge 1.21.1')
}
export function isPlayerBridgeMod(id: string): boolean { return id === 'kamucl-bridge' || id === 'kamucl_bridge' }
