package com.nomadcraft.numen.mixin;
import java.util.UUID;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import com.nomadcraft.numen.Adapter;
/** All native command and packet summon paths meet here. Numen itself remains unchanged. */
@Mixin(targets="com.dwinovo.numen.entity.Companions",remap=false)
public class SummonMixin {
 @Inject(method="summon(Lnet/minecraft/server/MinecraftServer;Ljava/util/UUID;Ljava/lang/String;Lnet/minecraft/class_3218;Lnet/minecraft/class_243;Lcom/dwinovo/numen/entity/MojangSkins$Skin;)Lcom/dwinovo/numen/entity/NumenPlayer;",at=@At("HEAD"),remap=false)
 private static void nomadAdmission(@Coerce Object server,UUID owner,String name,@Coerce Object level,@Coerce Object position,@Coerce Object skin,CallbackInfoReturnable<Object> callback){if(!Adapter.allowed(owner,name,skin))throw new IllegalStateException("NomadCraft: 请先在启动器提交机器人接入申请并等待审核；审核后通过云端控制台加入。");}
}
