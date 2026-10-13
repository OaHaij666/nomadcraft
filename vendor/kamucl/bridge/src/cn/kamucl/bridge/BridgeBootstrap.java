package cn.kamucl.bridge;

final class BridgeBootstrap {
    private BridgeBootstrap() {}
    static void initialize() {
        try {
            java.nio.file.Path gameDir = BridgePlatform.gameDir();
            ParamRegistry.init(gameDir);
            DemoModule.register();
            BridgeServer.start(gameDir, "1.0.1");
        } catch (Exception error) {
            System.err.println("[KAMUCL Bridge] Local bridge initialization failed: " + error.getMessage());
        }
    }
}
