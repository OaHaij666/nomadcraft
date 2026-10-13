package com.nomadcraft.numen.mixin;
import com.mojang.brigadier.context.CommandContext;
import org.spongepowered.asm.mixin.Mixin;import org.spongepowered.asm.mixin.injection.*;import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import com.nomadcraft.numen.Adapter;
@Mixin(targets="com.dwinovo.numen.entity.NumenCommands",remap=false)
public class SummonCommandMixin {
 @Inject(method="summon",at=@At("HEAD"),cancellable=true,remap=false)
 private static void check(CommandContext<?> context,String name,CallbackInfoReturnable<Integer> callback){if(!Adapter.nativeCommand(context,name))callback.setReturnValue(0);}
}
