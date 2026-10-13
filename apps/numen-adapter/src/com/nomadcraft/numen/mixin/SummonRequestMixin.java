package com.nomadcraft.numen.mixin;
import org.spongepowered.asm.mixin.Mixin;import org.spongepowered.asm.mixin.injection.*;import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import com.nomadcraft.numen.Adapter;
@Mixin(targets="com.dwinovo.numen.network.payload.SummonRequestPayload",remap=false)
public class SummonRequestMixin {
 @Inject(method="handle",at=@At("HEAD"),cancellable=true,remap=false)
 private static void check(@Coerce Object payload,@Coerce Object owner,CallbackInfo callback){if(!Adapter.nativeRequest(payload,owner))callback.cancel();}
}
