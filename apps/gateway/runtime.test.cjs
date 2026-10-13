const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {configuration}=require('./prepare.cjs'),{prepareBackend}=require('./backend.cjs');
test('offline gateway never listens or routes outside the loopback verification environment',()=>{
 const base={port:25565,isolatedOffline:true,rooms:[{id:'room',hostname:'room.nomad.invalid',backendHost:'127.0.0.1',backendPort:25566}]};
 assert.throws(()=>configuration({...base,bindHost:'0.0.0.0'}),/loopback/);
 assert.throws(()=>configuration({...base,rooms:[{...base.rooms[0],backendHost:'192.168.1.2'}]}),/loopback/);
 assert.match(configuration({...base,isolatedOffline:false} ),/online-mode = true/);
 assert.match(configuration({...base,verifyModernForwarding:true}),/player-info-forwarding-mode = "modern"/);
});
test('invalid backend adapter bytes fail before writing a mod or forwarding secret',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nomad-gateway-integrity-'));
 try{await assert.rejects(prepareBackend(dir,{minecraft:'1.20.1',loader:'fabric',secret:'a'.repeat(64)},{cache:path.join(dir,'missing-cache'),fetchArtifact:async()=>Buffer.from('corrupt downloaded jar')}),/checksum mismatch/);assert.deepEqual(await fs.readdir(dir),[]);}finally{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});}
});
test('existing forwarding configuration is preserved instead of replacing an unknown secret',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nomad-gateway-conflict-'));
 try{await fs.mkdir(path.join(dir,'config'));const file=path.join(dir,'config/FabricProxy-Lite.toml');await fs.writeFile(file,'secret = "existing"\n');await assert.rejects(prepareBackend(dir,{minecraft:'1.20.1',loader:'fabric',secret:'a'.repeat(64)},{cache:path.join(__dirname,'dist/dependencies')}),/configuration conflicts/);assert.equal(await fs.readFile(file,'utf8'),'secret = "existing"\n');assert.deepEqual(await fs.readdir(path.join(dir,'mods')),[]);}finally{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});}
});

test('room loader classification cannot inject or select an unsupported handover protocol',()=>{
 const base={port:25565,rooms:[{id:'room',hostname:'room.nomad.invalid',backendHost:'127.0.0.1',backendPort:25566}]};
 for(const loader of ['neoforge\nother=forge','unknown',''])assert.throws(()=>configuration({...base,rooms:[{...base.rooms[0],loader}]}),/loader/);
 for(const loader of ['fabric','forge','neoforge','vanilla','paper'])assert.match(configuration({...base,rooms:[{...base.rooms[0],loader}]}),/online-mode = true/);
});
