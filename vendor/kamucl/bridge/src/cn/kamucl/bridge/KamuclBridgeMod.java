package cn.kamucl.bridge;
import net.fabricmc.api.ModInitializer;
/** Fabric entrypoint. The shared bootstrap also serves the independent Forge/NeoForge entries. */
public final class KamuclBridgeMod implements ModInitializer {
    public static final String MOD_ID = "kamucl-bridge";
    public static final String VERSION = "1.0.1";
    @Override public void onInitialize() { BridgeBootstrap.initialize(); }
}
