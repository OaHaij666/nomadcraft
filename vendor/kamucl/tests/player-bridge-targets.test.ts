import test from 'node:test'
import assert from 'node:assert/strict'
import { playerBridgeArtifact, isPlayerBridgeMod } from '../src/shared/bridgeTargets'
test('player bridge resolves all four supported runtimes to matching loader artifacts',()=>{
 assert.equal(playerBridgeArtifact({loader:'fabric',mcVersion:'1.20.1'}),'kamucl-bridge.jar')
 assert.equal(playerBridgeArtifact({loader:'fabric',mcVersion:'1.21.1'}),'kamucl-bridge.jar')
 assert.equal(playerBridgeArtifact({loader:'forge',mcVersion:'1.20.1'}),'kamucl-bridge-forge-1.20.1-1.0.1.jar')
 assert.equal(playerBridgeArtifact({loader:'neoforge',mcVersion:'1.21.1'}),'kamucl-bridge-neoforge-1.21.1-1.0.1.jar')
 for(const profile of [{loader:'vanilla',mcVersion:'1.20.1'},{loader:'forge',mcVersion:'1.21.1'},{loader:'neoforge',mcVersion:'1.20.1'}])assert.throws(()=>playerBridgeArtifact(profile),/玩家命令桥接/)
})
test('both real bridge IDs are recognized without matching similarly named third-party mods',()=>{
 assert.equal(isPlayerBridgeMod('kamucl-bridge'),true);assert.equal(isPlayerBridgeMod('kamucl_bridge'),true)
 for(const id of ['kamucl-demo','my-kamucl-bridge','kamucl_bridge_custom',''])assert.equal(isPlayerBridgeMod(id),false)
})
