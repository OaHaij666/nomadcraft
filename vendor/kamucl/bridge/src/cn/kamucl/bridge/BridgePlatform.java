package cn.kamucl.bridge;

import java.io.InputStream;
import java.nio.file.Path;
import java.util.Properties;

/** Loader names are fixed at build time; no Minecraft client class loads on a dedicated server. */
final class BridgePlatform {
    private static final Properties NAMES = new Properties();
    private static final Object FABRIC;
    private static final Object MAPPINGS;
    static {
        Object fabric = null, mappings = null;
        try {
            try (InputStream input = BridgePlatform.class.getResourceAsStream("/bridge-platform.properties")) {
                if (input != null) NAMES.load(input);
            }
            if (NAMES.getProperty("loader", "fabric").equals("fabric")) {
                Class<?> loader = Class.forName("net.fabricmc.loader.api.FabricLoader");
                fabric = loader.getMethod("getInstance").invoke(null);
                mappings = loader.getMethod("getMappingResolver").invoke(fabric);
            }
        } catch (Exception error) { throw new ExceptionInInitializerError(error); }
        FABRIC = fabric; MAPPINGS = mappings;
    }
    static boolean isClient() throws Exception {
        if (FABRIC != null) return Class.forName("net.fabricmc.loader.api.FabricLoader").getMethod("getEnvironmentType").invoke(FABRIC).toString().equals("CLIENT");
        String prefix = NAMES.getProperty("loader").equals("forge") ? "net.minecraftforge.fml.loading" : "net.neoforged.fml.loading";
        return Class.forName(prefix + ".FMLEnvironment").getField("dist").get(null).toString().equals("CLIENT");
    }
    static Path gameDir() throws Exception {
        if (FABRIC != null) return (Path) Class.forName("net.fabricmc.loader.api.FabricLoader").getMethod("getGameDir").invoke(FABRIC);
        String prefix = NAMES.getProperty("loader").equals("forge") ? "net.minecraftforge.fml.loading" : "net.neoforged.fml.loading";
        Object directory = Class.forName(prefix + ".FMLPaths").getField("GAMEDIR").get(null);
        return (Path) directory.getClass().getMethod("get").invoke(directory);
    }
    static String className(String intermediary) throws Exception {
        if (MAPPINGS != null) return (String) Class.forName("net.fabricmc.loader.api.MappingResolver").getMethod("mapClassName", String.class, String.class).invoke(MAPPINGS, "intermediary", intermediary);
        String name = NAMES.getProperty("class." + intermediary);
        if (name == null) throw new ClassNotFoundException("Unmapped client class: " + intermediary);
        return name;
    }
    static String methodName(String owner, String method, String descriptor) throws Exception {
        if (MAPPINGS != null) return (String) Class.forName("net.fabricmc.loader.api.MappingResolver").getMethod("mapMethodName", String.class, String.class, String.class, String.class).invoke(MAPPINGS, "intermediary", owner, method, descriptor);
        String name = NAMES.getProperty("method." + method);
        if (name == null) throw new NoSuchMethodException("Unmapped client method: " + method);
        return name;
    }
}
