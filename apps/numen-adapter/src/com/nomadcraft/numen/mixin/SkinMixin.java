package com.nomadcraft.numen.mixin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import com.nomadcraft.numen.Adapter;
@Mixin(targets="com.dwinovo.numen.network.payload.ChangeSkinPayload",remap=false)
public class SkinMixin {
 @Inject(method="handle",at=@At("HEAD"),cancellable=true,remap=false)
 private static void nomadSkin(@Coerce Object payload,@Coerce Object player,CallbackInfo callback){if(!Adapter.skinChange(payload,player))callback.cancel();}
}
