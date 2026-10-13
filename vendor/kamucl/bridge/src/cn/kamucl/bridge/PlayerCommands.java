package cn.kamucl.bridge;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/** Send through the current client's signed command channel; never use a bot or elevated source. */
public final class PlayerCommands {
    private PlayerCommands() {}
    public static Map<String,Object> send(String command) throws Exception {
        if(command == null || command.length() > 2000 || command.contains("\n") || command.contains("\r") || !(command.startsWith("numen ") || command.startsWith("ysm ") || command.startsWith("nomad-bot-task "))) throw new IllegalArgumentException("Only single-line Numen/YSM commands are supported");
        if(!BridgePlatform.isClient()) throw new IllegalStateException("This operation requires the player's game client");
        Class<?> mc=Class.forName(BridgePlatform.className("net.minecraft.class_310"));
        String getInstance=BridgePlatform.methodName("net.minecraft.class_310","method_1551","()Lnet/minecraft/class_310;");
        Object client=mc.getMethod(getInstance).invoke(null);
        String getNetwork=BridgePlatform.methodName("net.minecraft.class_310","method_1562","()Lnet/minecraft/class_634;");
        String send=BridgePlatform.methodName("net.minecraft.class_634","method_45730","(Ljava/lang/String;)V");
        CompletableFuture<Map<String,Object>> result=new CompletableFuture<>();
        ((Executor)client).execute(()->{
            try {
                Object network=mc.getMethod(getNetwork).invoke(client);
                if(network==null)throw new IllegalStateException("Enter a world before sending a command");
                network.getClass().getMethod(send,String.class).invoke(network,command);
                result.complete(Map.of("ok",true,"state","sent","identity","current-player"));
            }catch(Exception e){result.completeExceptionally(e);}
        });
        return result.get(10,TimeUnit.SECONDS);
    }
}
