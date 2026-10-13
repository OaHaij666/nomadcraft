package com.nomadcraft.numen.mixin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import com.nomadcraft.numen.Adapter;
@Mixin(targets="net.minecraft.server.MinecraftServer",remap=false)
public class ServerMixin {
 @Inject(method="method_29741",at=@At("HEAD"),remap=false)
 private void nomadStart(CallbackInfo callback){Adapter.start(this);}
 @Inject(method="method_29741",at=@At("RETURN"),remap=false)
 private void nomadStop(CallbackInfo callback){Adapter.stop();}
}
