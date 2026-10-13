import crypto from 'node:crypto'
// Run after npm run build; validates the actual JARs distributed to players.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { playerBridgeArtifact } from '../src/shared/bridgeTargets'

test('packaged Forge and NeoForge bridges include valid resource pack metadata',()=>{
 const require=createRequire(path.resolve('package.json')); const Zip=require('adm-zip');
 for(const target of [{loader:'forge',mcVersion:'1.20.1',packFormat:15},{loader:'neoforge',mcVersion:'1.21.1',packFormat:34}]){
  const file=path.resolve('out/main',playerBridgeArtifact(target)); assert(fs.existsSync(file),'Build the client before artifact verification: '+file);
  const zip=new Zip(file); const entry=zip.getEntry('pack.mcmeta'); assert(entry,'Missing pack.mcmeta: '+target.loader);
  const metadata=JSON.parse(zip.readAsText(entry)); assert.equal(metadata.pack.pack_format,target.packFormat); assert.equal(typeof metadata.pack.description,'string');
 }
})

test('all packaged independent adapters match their manifest and FML adapters expose resource pack metadata',()=>{
 const require=createRequire(path.resolve('package.json'));const Zip=require('adm-zip');
 const manifest=JSON.parse(fs.readFileSync(path.resolve('out/main/nomad-numen-adapters.json'),'utf8'));assert.equal(manifest.artifacts.length,4);
 for(const target of manifest.artifacts){const bytes=fs.readFileSync(path.resolve('out/main',target.file));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),target.sha256);if(target.loader==='fabric')continue;const metadata=JSON.parse(new Zip(bytes).readAsText('pack.mcmeta'));assert.equal(metadata.pack.pack_format,target.minecraft==='1.20.1'?15:34)}
})
