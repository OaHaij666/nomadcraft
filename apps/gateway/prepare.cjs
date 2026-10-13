const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const artifacts=[
 {file:'velocity.jar',cache:'velocity-3.3.0-436.jar',url:'https://fill-data.papermc.io/v1/objects/06bb2a6ac16228a2f33a0336952624e6918a97535d36a3660725b18e2a6efdfb/velocity-3.3.0-SNAPSHOT-436.jar',sha256:'06bb2a6ac16228a2f33a0336952624e6918a97535d36a3660725b18e2a6efdfb'},
 {file:'plugins/limboapi.jar',cache:'limboapi-1.1.26.jar',url:'https://github.com/Elytrium/LimboAPI/releases/download/1.1.26/limboapi-1.1.26.jar',sha256:'8bcf9b76608875f0cf7008a76098d6941e86b4b72e61fdb72dc37da94eabe43b'},
 {file:'plugins/reconnect.jar',cache:'reconnect-velocity-1.0.0.jar',url:'https://github.com/REZANANS-yep/Reconnect-Velocity/releases/download/v1.0.0/reconnect-velocity-1.0.0.jar',sha256:'cde9086179672c31710fe9401afb7c7f76ad2546ebe27d7593869b3237dba1c5'}
];
artifacts.push({file:'plugins/ambassador.jar',cache:'ambassador-1.4.5.jar',url:'https://github.com/adde0109/Ambassador/releases/download/v1.4.5/Ambassador-Velocity-1.4.5-all.jar',sha256:'7c57a649c3948672cbef35a3baa8f73b046ac509ea8ffa6ee3008890d36f2c17',when:'forge'});
const quote=JSON.stringify;
function endpoint(host,port){if(typeof host!=='string'||!/^[a-z0-9.:-]+$/i.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid gateway endpoint');return (host.includes(':')?'['+host+']':host)+':'+port;}
function configuration(input){
 const bindHost=input.bindHost??'127.0.0.1',offline=input.isolatedOffline===true,rooms=input.rooms;
 if(offline&&bindHost!=='127.0.0.1')throw Error('Offline gateway verification must remain loopback-only');
 if(!Array.isArray(rooms)||!rooms.length||rooms.length>100)throw Error('Configure at least one room');
 const ids=new Set(),hosts=new Set();for(const room of rooms){if(room.loader!==undefined&&!['fabric','forge','neoforge','vanilla','paper'].includes(room.loader))throw Error('Invalid gateway room loader');if(!/^[a-z0-9_-]{1,80}$/.test(room.id)||ids.has(room.id)||!/^[a-z0-9.-]{1,200}$/.test(room.hostname)||hosts.has(room.hostname))throw Error('Invalid or duplicate gateway room');ids.add(room.id);hosts.add(room.hostname);if(offline&&room.backendHost!=='127.0.0.1')throw Error('Offline backends must remain loopback-only');endpoint(room.backendHost,room.backendPort);}
 return 'config-version = "2.7"\n'+
 'bind = '+quote(endpoint(bindHost,input.port))+'\n'+
 'motd = "NomadCraft"\nshow-max-players = 100\nonline-mode = '+(!offline)+'\nforce-key-authentication = '+(!offline)+'\n'+
 'player-info-forwarding-mode = '+quote(offline&&!input.verifyModernForwarding?'none':'modern')+'\nforwarding-secret-file = "forwarding.secret"\nannounce-forge = true\n'+
 '[servers]\n'+rooms.map(r=>r.id+' = '+quote(endpoint(r.backendHost,r.backendPort))).join('\n')+'\ntry = '+quote([rooms[0].id])+'\n'+
 '[forced-hosts]\n'+rooms.map(r=>quote(r.hostname)+' = '+quote([r.id])).join('\n')+'\n'+
 '[advanced]\ncompression-threshold = 256\ncompression-level = -1\nread-timeout = 30000\nconnection-timeout = 5000\nfailover-on-unexpected-server-disconnect = true\n';
}
async function prepare(directory,input,{cache,lifecycleJar}={}){
 cache??=path.join(__dirname,"dist/dependencies");
 const config=configuration(input),root=path.resolve(directory);await fsp.mkdir(root,{recursive:true});
 for(const artifact of artifacts){if(artifact.when==='forge'&&!input.rooms.some(room=>room.loader==='forge'))continue;let bytes;const cached=cache?path.join(cache,artifact.cache):undefined;if(cached&&fs.existsSync(cached))bytes=await fsp.readFile(cached);else{const response=await fetch(artifact.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Gateway download failed: '+response.status);bytes=Buffer.from(await response.arrayBuffer());}
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('Gateway artifact checksum mismatch: '+artifact.file);const destination=path.join(root,artifact.file);await fsp.mkdir(path.dirname(destination),{recursive:true});await fsp.writeFile(destination,bytes);
 }
 const own=lifecycleJar??path.join(__dirname,'dist/nomad-gateway.jar');if(!fs.existsSync(own))throw Error('Build apps/gateway lifecycle plugin first');
 await fsp.copyFile(own,path.join(root,'plugins/nomad-gateway.jar'));
 const secret=path.join(root,'forwarding.secret');if(!fs.existsSync(secret))await fsp.writeFile(secret,crypto.randomBytes(32).toString('hex'),{mode:0o600});
 await fsp.writeFile(path.join(root,'velocity.toml'),config);
 await fsp.writeFile(path.join(root,'nomad-room-loaders.properties'),input.rooms.map(room=>room.id+'='+room.loader).join('\n')+'\n');
 await fsp.mkdir(path.join(root,'plugins/limboapi'),{recursive:true});
 await fsp.writeFile(path.join(root,'plugins/limboapi/config.yml'),'main:\n  check-for-updates: false\n  prepare-min-version: "1_20"\n  prepare-max-version: "1_21"\n');
 await fsp.mkdir(path.join(root,'plugins/reconnect-velocity'),{recursive:true});
 await fsp.writeFile(path.join(root,'plugins/reconnect-velocity/config.yml'),'version: "1.0.0"\ndebug: true\nmain:\n  default-locale: en_US\n  delay-before-trying: 1000\n  delay-between-reconnects: 1000\n  reconnect-timeout: 6000\n  max-reconnect-time: 900000\n  max-reconnects: 900\nping:\n  successes-needed: 2\nlimbo:\n  read-timeout: 45000\n');
 await fsp.writeFile(path.join(root,'nomad-gateway-manifest.json'),JSON.stringify({schema:1,artifacts,rooms:input.rooms,isolatedOffline:input.isolatedOffline===true},null,2));
 return {directory:root,javaArgs:['-Xms128M','-Xmx512M','-jar','velocity.jar'],rooms:input.rooms};
}
module.exports={prepare,configuration,artifacts};
if(require.main===module){const [configFile,directory]=process.argv.slice(2);if(!configFile||!directory)throw Error('Usage: node apps/gateway/prepare.cjs <configuration.json> <runtime-directory>');prepare(directory,JSON.parse(fs.readFileSync(configFile,'utf8'))).then(()=>console.log('Gateway prepared')).catch(error=>{console.error(error);process.exitCode=1;});}
