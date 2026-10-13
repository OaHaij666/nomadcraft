package com.nomadcraft.numen;
import com.google.gson.*;
import com.sun.net.httpserver.*;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.arguments.StringArgumentType;
import java.lang.reflect.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
/** Independent released-mod adapter. No model credentials are accepted or stored here. */
public final class Adapter {
 private static final Gson JSON=new Gson();
 private static volatile Object server;
 private static volatile boolean localMode;
 private static volatile JsonObject policy=new JsonObject();
 private static volatile long policyAt;
 private static volatile HttpServer http;
 private static volatile String token="";
 private static final ThreadLocal<Boolean> privileged=ThreadLocal.withInitial(()->false);
 private static final UUID SHARED_OWNER=UUID.nameUUIDFromBytes("NomadCraft shared Numen bodies".getBytes(StandardCharsets.UTF_8));
 private static final Map<UUID,Deque<String>> events=new ConcurrentHashMap<>();
 private static final Queue<Map<String,String>> links=new ConcurrentLinkedQueue<>();
 private static final Map<String,CompletableFuture<Object>> active=new ConcurrentHashMap<>();
 private static volatile ExecutorService httpWorkers;
 private static Class<?> cls(String name)throws Exception {return Class.forName(name.startsWith("net.minecraft.")?Platform.className(name):name);}
 private static Object mc(Object target,String owner,String method,String descriptor,Object...args)throws Exception {
  String name=Platform.methodName(owner,method,descriptor);
  for(Method candidate:target.getClass().getMethods())if(candidate.getName().equals(name)&&candidate.getParameterCount()==args.length)return candidate.invoke(target,args);
  throw new NoSuchMethodException(owner+"."+name);
 }
 private static Object call(String type,String name,Object...args)throws Exception{return callOn(cls(type),null,name,args);}
 private static Object invoke(Object target,String name,Object...args)throws Exception{return callOn(target.getClass(),target,name,args);}
 private static Object callOn(Class<?> type,Object target,String name,Object...args)throws Exception {
  outer:for(Method method:type.getMethods())if(method.getName().equals(name)&&method.getParameterCount()==args.length){Class<?>[] types=method.getParameterTypes();for(int i=0;i<args.length;i++)if(args[i]!=null&&!types[i].isInstance(args[i])&&!types[i].isPrimitive())continue outer;return method.invoke(target,args);}
  throw new NoSuchMethodException(type.getName()+"."+name);
 }
 public static boolean allowed(UUID owner,String name,Object skin){
  if(localMode)return true;
  if(!policy.has("enabled")||!policy.get("enabled").getAsBoolean()||System.currentTimeMillis()-policyAt>15000)return false;
  for(JsonElement element:policy.getAsJsonArray("bots")){JsonObject bot=element.getAsJsonObject();UUID expected=bot.get("scope").getAsString().equals("shared")?SHARED_OWNER:uuid(bot.get("ownerUuid").getAsString());
   if(expected!=null&&expected.equals(owner)&&bot.get("name").getAsString().equals(name))return skinMatches(bot,skin);
  }return false;
 }
 private static boolean skinMatches(JsonObject bot,Object skin){try{JsonElement approved=bot.get("skin");if(approved==null||approved.isJsonNull())return skin==null;if(skin==null)return false;JsonObject signed=approved.getAsJsonObject();return signed.get("value").getAsString().equals(invoke(skin,"value"))&&signed.get("signature").getAsString().equals(invoke(skin,"signature"));}catch(Exception ignored){return false;}}
 public static boolean skinChange(Object payload,Object player){try{UUID id=(UUID)invoke(payload,"uuid");Object registry=call("com.dwinovo.numen.entity.CompanionRegistry","get",server),entry=invoke(registry,"find",id);if(entry==null)return false;UUID owner=(UUID)invoke(entry,"owner");String name=(String)invoke(entry,"name");Object skin=cls("com.dwinovo.numen.entity.MojangSkins$Skin").getConstructors()[0].newInstance(invoke(payload,"skinValue"),invoke(payload,"skinSig"));return allowed(owner,name,skin);}catch(Exception ignored){return false;}}
 public static boolean nativeRequest(Object payload,Object player){try{String name=(String)invoke(payload,"name");String value=(String)invoke(payload,"skinValue"),signature=(String)invoke(payload,"skinSig");Object skin=value==null||value.isBlank()?null:cls("com.dwinovo.numen.entity.MojangSkins$Skin").getConstructors()[0].newInstance(value,signature);UUID owner=(UUID)mc(player,"net.minecraft.class_1297","method_5667","()Ljava/util/UUID;");if(allowed(owner,name,skin))return true;denied(player);return false;}catch(Exception ignored){return false;}}
 public static boolean nativeCommand(Object context,String name){try{Object source=invoke(context,"getSource"),player=mc(source,"net.minecraft.class_2168","method_44023","()Lnet/minecraft/class_3222;");if(player==null)return false;UUID owner=(UUID)mc(player,"net.minecraft.class_1297","method_5667","()Ljava/util/UUID;");if(allowed(owner,name,null))return true;denied(player);return false;}catch(Exception ignored){return false;}}
 public static void denied(Object player){try{Object text=cls("net.minecraft.class_2561").getMethod(Platform.methodName("net.minecraft.class_2561","method_30163","(Ljava/lang/String;)Lnet/minecraft/class_2561;"),String.class).invoke(null,"NomadCraft: 请先启用实例陪玩、验证游戏身份，并等待机器人及外观审核通过。");mc(player,"net.minecraft.class_1657","method_7353","(Lnet/minecraft/class_2561;Z)V",text,false);}catch(Exception ignored){}}
 private static UUID uuid(String value){try{return UUID.fromString(value);}catch(Exception ignored){return null;}}
 public static synchronized void start(Object instance){
  if(server!=null)return;server=instance;try{localMode=Platform.localMode();}catch(Exception error){server=null;throw new IllegalStateException("Cannot detect loader environment",error);}
  Thread thread=new Thread(()->{try{
   // Fail closed if the installed release does not expose these exact server APIs.
   cls("com.dwinovo.numen.entity.Companions");cls("com.dwinovo.numen.program.ServerPrograms");
   byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);token=HexFormat.of().formatHex(bytes);
   http=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);httpWorkers=Executors.newFixedThreadPool(8,r->{Thread worker=new Thread(r,"nomad-numen-http");worker.setDaemon(true);return worker;});http.setExecutor(httpWorkers);http.createContext("/nomad/bots",Adapter::request);http.start();
   Path discovery=Platform.gameDir().resolve(".nomad-numen-adapter.json");Path temp=discovery.resolveSibling(discovery.getFileName()+".tmp");Files.writeString(temp,JSON.toJson(Map.of("protocol",1,"port",http.getAddress().getPort(),"token",token)));Files.move(temp,discovery,StandardCopyOption.REPLACE_EXISTING);
   Object watcher=Proxy.newProxyInstance(Adapter.class.getClassLoader(),new Class<?>[]{cls("com.dwinovo.numen.event.NumenEvents$Watcher")},(proxy,method,args)->{if(method.getName().equals("takes")){UUID id=(UUID)args[0];Deque<String> queue=events.computeIfAbsent(id,k->new ConcurrentLinkedDeque<>());String type=String.valueOf(invoke(args[1],"type"));if(type.equals("server_message"))return false;queue.addLast(String.valueOf(invoke(args[1],"text")));while(queue.size()>200)queue.pollFirst();return false;}return objectMethod(proxy,method,args);});call("com.dwinovo.numen.event.NumenEvents","watch",watcher);
   ((Executor)server).execute(()->{try{registerLinkCommand();}catch(Exception error){System.err.println("[nomad-numen] Player link command unavailable: "+error.getClass().getSimpleName());}});
  }catch(Exception error){System.err.println("[nomad-numen] Adapter unavailable: "+error.getClass().getSimpleName());stop();}},"nomad-numen-adapter");thread.setDaemon(true);thread.start();
 }
 private static Object objectMethod(Object proxy,Method method,Object[]args){return switch(method.getName()){case "toString"->"NomadCraft server transport";case "hashCode"->System.identityHashCode(proxy);case "equals"->proxy==args[0];default->null;};}
 @SuppressWarnings("unchecked") private static void registerLinkCommand()throws Exception {
  Object manager=mc(server,"net.minecraft.server.MinecraftServer","method_3734","()Lnet/minecraft/class_2170;");
  CommandDispatcher<Object> dispatcher=(CommandDispatcher<Object>)mc(manager,"net.minecraft.class_2170","method_9235","()Lcom/mojang/brigadier/CommandDispatcher;");
  registerTaskCommand(dispatcher);
  dispatcher.register(LiteralArgumentBuilder.<Object>literal("nomad-bot-link").then(RequiredArgumentBuilder.<Object,String>argument("code",StringArgumentType.word()).executes(context->{try{
   String code=StringArgumentType.getString(context,"code");if(!code.matches("[0-9a-f]{32}"))return 0;
   Object player=mc(context.getSource(),"net.minecraft.class_2168","method_44023","()Lnet/minecraft/class_3222;");if(player==null)return 0;
   UUID id=(UUID)mc(player,"net.minecraft.class_1297","method_5667","()Ljava/util/UUID;");if(links.size()>=100)return 0;links.add(Map.of("code",code,"uuid",id.toString()));return 1;
  }catch(Exception error){return 0;}})));
 }
 private static void registerTaskCommand(CommandDispatcher<Object> dispatcher){
  dispatcher.register(LiteralArgumentBuilder.<Object>literal("nomad-bot-task").then(RequiredArgumentBuilder.<Object,String>argument("bot",StringArgumentType.word()).then(RequiredArgumentBuilder.<Object,String>argument("task",StringArgumentType.greedyString()).executes(context->{try{
   Object player=mc(context.getSource(),"net.minecraft.class_2168","method_44023","()Lnet/minecraft/class_3222;");if(player==null)return 0;String name=StringArgumentType.getString(context,"bot"),text=StringArgumentType.getString(context,"task");if(text.length()>2000)return 0;UUID sender=(UUID)mc(player,"net.minecraft.class_1297","method_5667","()Ljava/util/UUID;");
   for(Map<String,Object> bot:roster())if(bot.get("name").equals(name)&&Boolean.TRUE.equals(bot.get("online"))&&SHARED_OWNER.toString().equals(bot.get("owner"))){UUID id=UUID.fromString(String.valueOf(bot.get("id")));Deque<String> queue=events.computeIfAbsent(id,key->new ConcurrentLinkedDeque<>());if(queue.size()>=200)return 0;queue.addLast("<player_input sender_uuid=\""+sender+"\">"+text.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")+"</player_input>");return 1;}return 0;
  }catch(Exception error){return 0;}}))));
 }
 private static void request(HttpExchange exchange){
  try{
   if(!MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8),String.valueOf(exchange.getRequestHeaders().getFirst("X-Nomad-Token")).getBytes(StandardCharsets.UTF_8))){respond(exchange,401,Map.of("ok",false));return;}
   if(!exchange.getRequestMethod().equals("POST")){respond(exchange,405,Map.of("ok",false));return;}
   byte[] bytes=exchange.getRequestBody().readNBytes(1024*1024+1);if(bytes.length>1024*1024){respond(exchange,413,Map.of("ok",false));return;}
   JsonObject body=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject();String action=body.get("action").getAsString();
   CompletableFuture<Object> result=new CompletableFuture<>();String requestId=body.has("requestId")?body.get("requestId").getAsString():UUID.randomUUID().toString();if(active.putIfAbsent(requestId,result)!=null)throw new IllegalStateException("duplicate_request");
   ((Executor)server).execute(()->{try{if(action.equals("policy")){policy=body.getAsJsonObject("args");policyAt=System.currentTimeMillis();List<Map<String,String>> drained=new ArrayList<>();for(Map<String,String> item;(item=links.poll())!=null;)drained.add(item);result.complete(Map.of("ready",true,"links",drained,"roster",roster()));}else operate(action,body.has("args")?body.getAsJsonObject("args"):new JsonObject(),result);}catch(Exception error){result.completeExceptionally(error);}});
   try{respond(exchange,200,Map.of("ok",true,"result",result.get(110,TimeUnit.SECONDS)));}finally{active.remove(requestId);}
  }catch(Exception error){respond(exchange,409,Map.of("ok",false,"error","adapter_operation_failed"));}
 }
 private static List<Map<String,Object>> roster()throws Exception {
  Object players=mc(server,"net.minecraft.server.MinecraftServer","method_3760","()Lnet/minecraft/class_3324;");List<Map<String,Object>> out=new ArrayList<>();
  if(!policy.has("bots"))return out;
  Object registry=call("com.dwinovo.numen.entity.CompanionRegistry","get",server);
  for(JsonElement element:policy.getAsJsonArray("bots")){JsonObject bot=element.getAsJsonObject();UUID owner=bot.get("scope").getAsString().equals("shared")?SHARED_OWNER:uuid(bot.get("ownerUuid").getAsString());if(owner==null)continue;
   for(Object raw:(List<?>)invoke(registry,"ownedBy",owner)){Map.Entry<?,?> entry=(Map.Entry<?,?>)raw;if(!invoke(entry.getValue(),"name").equals(bot.get("name").getAsString()))continue;Object live=call("com.dwinovo.numen.entity.NumenPlayer","findByUuid",server,entry.getKey());out.add(Map.of("id",entry.getKey().toString(),"name",bot.get("name").getAsString(),"owner",owner.toString(),"online",live!=null));}
  }return out;
 }
 private static JsonObject approved(JsonObject args){
  if(localMode){try{UUID id=uuid(args.get("companion").getAsString());Object registry=call("com.dwinovo.numen.entity.CompanionRegistry","get",server),entry=invoke(registry,"find",id);if(entry==null)throw new IllegalStateException("bot_not_registered");JsonObject bot=new JsonObject();bot.addProperty("name",String.valueOf(invoke(entry,"name")));bot.addProperty("scope","private");bot.addProperty("ownerUuid",String.valueOf(invoke(entry,"owner")));String value=String.valueOf(invoke(entry,"skinValue")),signature=String.valueOf(invoke(entry,"skinSig"));if(!value.isBlank()){JsonObject skin=new JsonObject();skin.addProperty("value",value);skin.addProperty("signature",signature);bot.add("skin",skin);}return bot;}catch(Exception error){throw new IllegalStateException("local_bot_unknown");}}
  if(!policy.has("enabled")||!policy.get("enabled").getAsBoolean()||System.currentTimeMillis()-policyAt>15000)throw new IllegalStateException("bot_policy_offline");
  for(JsonElement element:policy.getAsJsonArray("bots")){JsonObject bot=element.getAsJsonObject();if(bot.get("name").getAsString().equals(args.get("name").getAsString())&&bot.get("scope").getAsString().equals(args.get("scope").getAsString()))return bot;}throw new IllegalStateException("bot_admission_required");
 }
 private static void operate(String action,JsonObject args,CompletableFuture<Object> result)throws Exception {
  JsonObject bot=approved(args);UUID owner=bot.get("scope").getAsString().equals("shared")?SHARED_OWNER:uuid(bot.get("ownerUuid").getAsString());if(owner==null)throw new IllegalStateException("player_identity_link_required");
  UUID companion=null;Object registry=call("com.dwinovo.numen.entity.CompanionRegistry","get",server);
  for(Object raw:(List<?>)invoke(registry,"ownedBy",owner)){Map.Entry<?,?> entry=(Map.Entry<?,?>)raw;if(invoke(entry.getValue(),"name").equals(bot.get("name").getAsString()))companion=(UUID)entry.getKey();}
  if(action.equals("join")){
   Object players=mc(server,"net.minecraft.server.MinecraftServer","method_3760","()Lnet/minecraft/class_3324;");Object player=mc(players,"net.minecraft.class_3324","method_14602","(Ljava/util/UUID;)Lnet/minecraft/class_3222;",owner);Object level,position;
   if(player!=null){level=mc(player,"net.minecraft.class_1297","method_37908","()Lnet/minecraft/class_1937;");position=mc(player,"net.minecraft.class_1297","method_19538","()Lnet/minecraft/class_243;");}
   else{if(bot.get("scope").getAsString().equals("private"))throw new IllegalStateException("owner_not_in_game");level=mc(server,"net.minecraft.server.MinecraftServer","method_30002","()Lnet/minecraft/class_3218;");Object spawn=mc(level,"net.minecraft.class_1937","method_43126","()Lnet/minecraft/class_2338;");position=cls("net.minecraft.class_243").getConstructor(double.class,double.class,double.class).newInstance(((Number)mc(spawn,"net.minecraft.class_2382","method_10263","()I")).doubleValue()+0.5,((Number)mc(spawn,"net.minecraft.class_2382","method_10264","()I")).doubleValue()+1,((Number)mc(spawn,"net.minecraft.class_2382","method_10260","()I")).doubleValue()+0.5);}
   Object skin=null;if(bot.has("skin")&&!bot.get("skin").isJsonNull()){JsonObject signed=bot.getAsJsonObject("skin");skin=cls("com.dwinovo.numen.entity.MojangSkins$Skin").getConstructors()[0].newInstance(signed.get("value").getAsString(),signed.get("signature").getAsString());}Object live=call("com.dwinovo.numen.entity.Companions","summon",server,owner,bot.get("name").getAsString(),level,position,skin);UUID id=(UUID)mc(live,"net.minecraft.class_1297","method_5667","()Ljava/util/UUID;");if(player!=null)call("com.dwinovo.numen.entity.Companions","syncRosterToOwner",server,player);result.complete(Map.of("id",id.toString()));return;
  }
  if(companion==null)throw new IllegalStateException("bot_not_spawned");Object live=call("com.dwinovo.numen.entity.NumenPlayer","findByUuid",server,companion);
  if(action.equals("get_events")){Deque<String> queue=events.get(companion);List<String> batch=new ArrayList<>();if(queue!=null)for(String event;batch.size()<30&&(event=queue.pollFirst())!=null;)batch.add(event);result.complete(batch.isEmpty()?"(no events)":String.join("\n",batch));return;}
  if(live==null)throw new IllegalStateException("bot_not_online");
  if(action.equals("leave")){call("com.dwinovo.numen.program.ServerPrograms","stop",live);call("com.dwinovo.numen.entity.Companions","dormant",server,live);Object players=mc(server,"net.minecraft.server.MinecraftServer","method_3760","()Lnet/minecraft/class_3324;");Object player=mc(players,"net.minecraft.class_3324","method_14602","(Ljava/util/UUID;)Lnet/minecraft/class_3222;",owner);if(player!=null)call("com.dwinovo.numen.entity.Companions","syncRosterToOwner",server,player);result.complete("left; player data preserved");return;}
  if(action.equals("delete")){call("com.dwinovo.numen.entity.Companions","dismiss",server,live);result.complete("permanently deleted");return;}
  if(action.equals("say")){String text=args.get("text").getAsString();if(text.length()>4000)throw new IllegalArgumentException();Object component=cls("net.minecraft.class_2561").getMethod(Platform.methodName("net.minecraft.class_2561","method_30163","(Ljava/lang/String;)Lnet/minecraft/class_2561;"),String.class).invoke(null,"<"+bot.get("name").getAsString()+"> "+text);Object players=mc(server,"net.minecraft.server.MinecraftServer","method_3760","()Lnet/minecraft/class_3324;");mc(players,"net.minecraft.class_3324","method_43514","(Lnet/minecraft/class_2561;Z)V",component,false);result.complete("spoken");return;}
  if(!action.equals("lua"))throw new IllegalArgumentException("unsupported_action");String code=args.has("code")?args.get("code").getAsString():args.get("script").getAsString();if(code.length()>32000)throw new IllegalArgumentException("program_too_large");
  Class<?> transportType=cls("com.dwinovo.numen.program.ClientTransport");Object transport=Proxy.newProxyInstance(Adapter.class.getClassLoader(),new Class<?>[]{transportType},(proxy,method,values)->{if(method.getName().equals("request")){Class<?> answer=cls("com.dwinovo.numen.program.ClientTransport$Answer");Object reply=answer.getConstructors()[0].newInstance("{\"ok\":false,\"error\":{\"kind\":\"failed\",\"message\":\"This API needs an owner client and is unavailable on a server-owned bot\"}}",null);((Consumer<Object>)values[2]).accept(reply);return null;}if(method.getName().equals("cancel"))return null;return objectMethod(proxy,method,values);});
  Object modules=call("com.dwinovo.numen.program.ModuleSet","factory");Object request=cls("com.dwinovo.numen.program.ServerPrograms$Request").getConstructors()[0].newInstance(UUID.randomUUID().toString(),code,modules,true);Object observer=cls("com.dwinovo.numen.program.CallObserver").getField("NONE").get(null);
  call("com.dwinovo.numen.program.ServerPrograms","run",live,companion,owner,request,transport,observer,(Consumer<Object>)receipt->{try{result.complete(invoke(receipt,"toJson"));}catch(Exception error){result.completeExceptionally(error);}});
 }
 private static void respond(HttpExchange exchange,int status,Object body){try{byte[] bytes=JSON.toJson(body).getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","application/json");exchange.getResponseHeaders().set("Cache-Control","no-store");exchange.sendResponseHeaders(status,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();}catch(Exception ignored){}}
 public static synchronized void stop(){if(http!=null)http.stop(0);if(httpWorkers!=null)httpWorkers.shutdownNow();httpWorkers=null;http=null;server=null;localMode=false;policy=new JsonObject();policyAt=0;events.clear();links.clear();try{Files.deleteIfExists(Platform.gameDir().resolve(".nomad-numen-adapter.json"));}catch(Exception ignored){}}
}
