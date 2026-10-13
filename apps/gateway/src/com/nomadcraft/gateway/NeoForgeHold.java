package com.nomadcraft.gateway;

import com.velocitypowered.api.event.player.KickedFromServerEvent;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.proxy.connection.client.ConnectedPlayer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledFuture;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.title.Title;
import java.time.Duration;

/** Keeps the existing NeoForge PLAY world while the actual modded backend is saved/restored.
 * Never sends a vanilla configuration/registry negotiation to a required-mod client.
 * Uses the pinned Velocity session handler for keepalive and the real backend for the next CONFIG.
 */
final class NeoForgeHold {
 private final Properties loaders=new Properties();
 private final Map<UUID,Hold> holds=new ConcurrentHashMap<>();
 NeoForgeHold() throws Exception {try(var stream=Files.newInputStream(Path.of("nomad-room-loaders.properties"))){loaders.load(stream);}}
 boolean onKick(KickedFromServerEvent event){
  if(!"neoforge".equals(loaders.getProperty(event.getServer().getServerInfo().getName())))return false;
  ConnectedPlayer player=(ConnectedPlayer)event.getPlayer();Hold current=holds.get(player.getUniqueId());
  String reason=event.getServerKickReason().map(Object::toString).orElse("").toLowerCase(java.util.Locale.ROOT);
  boolean denied=reason.matches("(?s).*(banned|whitelist|expired_public_key|duplicate_login|already_connected|kicked).*" );
  if(denied)return false;
  if(current!=null){current.connecting=false;current.successes=0;return true;}
  if(event.kickedDuringServerConnect())return false;
  if(!reason.matches("(?s).*(server_shutdown|server closed|restart|connection.*(closed|error)|internal.*error).*"))return false;
  Hold hold=new Hold(player,event.getServer());holds.put(player.getUniqueId(),hold);
  player.getConnection().eventLoop().execute(hold::begin);
  return true;
 }
 void connected(UUID id){Hold hold=holds.remove(id);if(hold!=null){hold.close();if(hold.player.isActive())hold.player.getConnection().eventLoop().schedule(()->{if(hold.player.isActive()&&hold.player.getConnection().getState()==com.velocitypowered.proxy.protocol.StateRegistry.PLAY){hold.player.clearTitle();hold.player.sendActionBar(Component.empty());}},500,TimeUnit.MILLISECONDS);}}
 void disconnected(UUID id){connected(id);}
 void close(){for(Hold hold:holds.values())hold.close();holds.clear();}
 private final class Hold {
  final ConnectedPlayer player;final RegisteredServer target;final long started=System.nanoTime();
  ScheduledFuture<?> timer;boolean pinging,connecting;int successes,ticks;
  Hold(ConnectedPlayer player,RegisteredServer target){this.player=player;this.target=target;}
  void begin(){
   if(!player.isActive()){connected(player.getUniqueId());return;}
   // Keep PLAY and its original registry. The detached backend can no longer receive game input.
   player.setConnectedServer(null);
   player.showTitle(Title.title(Component.text("正在切换主机"),Component.text("存档正在保存和恢复，请稍候"),Title.Times.times(Duration.ZERO,Duration.ofSeconds(2),Duration.ZERO)));
   timer=player.getConnection().eventLoop().scheduleAtFixedRate(this::tick,0,1,TimeUnit.SECONDS);
   System.out.println("[nomad-gateway] NeoForge hold started");
  }
  void tick(){
   if(!player.isActive()){connected(player.getUniqueId());return;}
   if(System.nanoTime()-started>TimeUnit.MINUTES.toNanos(15)){connected(player.getUniqueId());player.disconnect(Component.text("等待新主机超时，请稍后重试"));return;}
   if(++ticks%5==0)player.sendKeepAlive();
   if(!connecting)player.sendActionBar(Component.text("正在切换主机，等待存档恢复…"));
   if(pinging||connecting)return;
   pinging=true;target.ping().orTimeout(5,TimeUnit.SECONDS).whenComplete((ping,error)->player.getConnection().eventLoop().execute(()->{
    pinging=false;if(holds.get(player.getUniqueId())!=this)return;
    if(error!=null){successes=0;return;}if(++successes<2)return;
    connecting=true;player.createConnectionRequest(target).connect().orTimeout(15,TimeUnit.SECONDS).whenComplete((result,failure)->player.getConnection().eventLoop().execute(()->{
     if(holds.get(player.getUniqueId())!=this)return;
     connecting=false;if(failure!=null||result==null||!result.isSuccessful())successes=0;
    }));
   }));
  }
  void close(){if(timer!=null)timer.cancel(false);}
 }
}
