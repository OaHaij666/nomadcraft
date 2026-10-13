package com.nomadcraft.numen;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.Properties;
/** Loader-specific names stay outside the policy and body operations. */
public final class Platform {
 private static final Properties NAMES=new Properties();
 private static final Object FABRIC, MAPPINGS;
 static {try {
   Object fabric=null, mappings=null;
   try {fabric=Class.forName("net.fabricmc.loader.api.FabricLoader").getMethod("getInstance").invoke(null);mappings=fabric.getClass().getMethod("getMappingResolver").invoke(fabric);}catch(ClassNotFoundException ignored){}
   FABRIC=fabric;MAPPINGS=mappings;
   try(var stream=Platform.class.getResourceAsStream("/nomad-platform.properties")){if(stream!=null)NAMES.load(stream);}
 }catch(Exception error){throw new ExceptionInInitializerError(error);}}
 public static String className(String name)throws Exception {
  if(!name.startsWith("net.minecraft."))return name;
  if(MAPPINGS!=null)return (String)Class.forName("net.fabricmc.loader.api.MappingResolver").getMethod("mapClassName",String.class,String.class).invoke(MAPPINGS,"intermediary",name);
  String value=NAMES.getProperty("class."+name);if(value==null)throw new ClassNotFoundException("Unmapped Minecraft class: "+name);return value;
 }
 public static String methodName(String owner,String method,String descriptor)throws Exception {
  if(MAPPINGS!=null)return (String)Class.forName("net.fabricmc.loader.api.MappingResolver").getMethod("mapMethodName",String.class,String.class,String.class,String.class).invoke(MAPPINGS,"intermediary",owner,method,descriptor);
  String value=NAMES.getProperty("method."+method);if(value==null)throw new NoSuchMethodException("Unmapped Minecraft method: "+method);return value;
 }
 public static Path gameDir()throws Exception {
  if(FABRIC!=null)return (Path)Class.forName("net.fabricmc.loader.api.FabricLoader").getMethod("getGameDir").invoke(FABRIC);
  String prefix=NAMES.getProperty("loader").equals("forge")?"net.minecraftforge.fml.loading":"net.neoforged.fml.loading";
  Object game=Class.forName(prefix+".FMLPaths").getField("GAMEDIR").get(null);return (Path)game.getClass().getMethod("get").invoke(game);
 }
 public static boolean localMode()throws Exception {
  if(FABRIC!=null)return Class.forName("net.fabricmc.loader.api.FabricLoader").getMethod("getEnvironmentType").invoke(FABRIC).toString().equals("CLIENT");
  String prefix=NAMES.getProperty("loader").equals("forge")?"net.minecraftforge.fml.loading":"net.neoforged.fml.loading";
  return Class.forName(prefix+".FMLEnvironment").getField("dist").get(null).toString().equals("CLIENT");
 }
}
