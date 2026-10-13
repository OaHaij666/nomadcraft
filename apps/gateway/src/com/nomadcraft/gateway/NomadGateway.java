package com.nomadcraft.gateway;
import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.PostOrder;
import com.velocitypowered.api.event.EventTask;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.player.GameProfileRequestEvent;
import com.velocitypowered.api.event.connection.PostLoginEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
import com.velocitypowered.proxy.connection.MinecraftConnection;
import com.velocitypowered.proxy.connection.client.ConnectedPlayer;
import com.velocitypowered.proxy.connection.client.LoginInboundConnection;
import net.elytrium.limboapi.LimboAPI;
import java.lang.reflect.Method;
import com.velocitypowered.api.proxy.ProxyServer;
import net.elytrium.limboapi.api.LimboFactory;
import net.elytrium.limboapi.api.event.LoginLimboRegisterEvent;
/** Joins LimboAPI's login lifecycle without running an authentication plugin. */
public final class NomadGateway {
 private final ProxyServer proxy;
 private LimboFactory limbo;
 private LimboAPI implementation;
 private NeoForgeHold neoHold;
 @Inject public NomadGateway(ProxyServer proxy){this.proxy=proxy;}
 @Subscribe public void initialize(ProxyInitializeEvent event) throws Exception {
  implementation=(LimboAPI)proxy.getPluginManager().getPlugin("limboapi").orElseThrow().getInstance().orElseThrow();
  limbo=implementation;
  neoHold=new NeoForgeHold();
  // Preserve LimboAPI's normal listeners, but let Ambassador own the first Forge handshake.
  proxy.getEventManager().unregisterListener(implementation,implementation.getLoginListener());
  proxy.getEventManager().register(this,new InitialConnectionListener());
 }
 // This is higher priority than LimboAPI's FIRST handler on our pinned Velocity version.
 @Subscribe(order=PostOrder.CUSTOM,priority=Short.MAX_VALUE) public void forgeProfile(GameProfileRequestEvent event) throws ReflectiveOperationException {
  if(!(event.getConnection() instanceof LoginInboundConnection login))return;
  Method method=LoginInboundConnection.class.getDeclaredMethod("delegatedConnection");
  method.setAccessible(true);
  if(isAmbassador((MinecraftConnection)method.invoke(login))){
   implementation.getEventManagerHook().proceedProfile(event.getGameProfile());
   System.out.println("[nomad-gateway] Preserving initial Forge login handshake");
  }
 }
 private static boolean isAmbassador(MinecraftConnection connection){
  return connection.getType().getClass().getName().startsWith("org.adde0109.ambassador.forge.");
 }
 @Subscribe(order=PostOrder.CUSTOM,priority=Short.MAX_VALUE) public EventTask forgeIdentity(PostLoginEvent event){
  if(!isAmbassador(((ConnectedPlayer)event.getPlayer()).getConnection()))return null;
  implementation.setInitialID(event.getPlayer(),event.getPlayer().getUniqueId());
  // Register Reconnect's kick callback without advancing the Forge client to PLAY.
  return EventTask.resumeWhenComplete(proxy.getEventManager().fire(new LoginLimboRegisterEvent(event.getPlayer()))
   .thenAccept(registration->implementation.setKickCallback(event.getPlayer(),registration.getOnKickCallback())));
 }
 public final class InitialConnectionListener {
  @Subscribe public void initial(PlayerChooseInitialServerEvent event){
   if(!isAmbassador(((ConnectedPlayer)event.getPlayer()).getConnection()))
    implementation.getLoginListener().hookInitialServer(event);
  }
  @Subscribe public void connected(ServerConnectedEvent event){
   neoHold.connected(event.getPlayer().getUniqueId());
   // Forge is still negotiating here in some event orders; Ambassador owns its PLAY transition.
   if(!isAmbassador(((ConnectedPlayer)event.getPlayer()).getConnection()))
    implementation.getLoginListener().hookPlaySession(event);
  }
 }
 @Subscribe public void left(com.velocitypowered.api.event.connection.DisconnectEvent event){neoHold.disconnected(event.getPlayer().getUniqueId());}
 @Subscribe public void shutdown(com.velocitypowered.api.event.proxy.ProxyShutdownEvent event){if(neoHold!=null)neoHold.close();}
 @Subscribe(order=PostOrder.LAST) public void login(LoginLimboRegisterEvent event){
  var original=event.getOnKickCallback();
  event.setOnKickCallback(kick->neoHold.onKick(kick)||(original!=null&&original.apply(kick)));
  // A login queue is required for LimboAPI to preserve the original game UUID.
  // Passing this task continues to other registered authentication tasks normally.
  event.addOnJoinCallback(()->limbo.passLoginLimbo(event.getPlayer()));
 }
}
