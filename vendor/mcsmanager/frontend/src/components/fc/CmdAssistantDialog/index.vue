<script setup lang="ts">
import { ref } from "vue";
import type { MountComponent } from "@/types";
import { t } from "@/lang/i18n";
import { useStartCmdBuilder } from "@/hooks/useGenerateStartCmd";
import { reportErrorMsg } from "@/tools/validator";
import MinecraftJavaForm from "./MinecraftJavaForm.vue";
const { minecraftJava, buildCmd } = useStartCmdBuilder();
const props = defineProps<MountComponent>();
const open = ref(true);
const formRef = ref<InstanceType<typeof MinecraftJavaForm>>();
const cancel = () => {
  open.value = false;
  props.destroyComponent?.();
};
const submit = async () => {
  try {
    await formRef.value?.validate();
  } catch (error) {
    return reportErrorMsg(t("TXT_CODE_d6c5a7f8"));
  }
  props.emitResult?.(buildCmd());
  cancel();
};
</script>
<template>
  <a-modal
    v-model:open="open"
    :width="680"
    :title="t('TXT_CODE_2728d0d4')"
    :ok-text="t('TXT_CODE_d507abff')"
    :cancel-text="t('TXT_CODE_a0451c97')"
    @ok="submit"
    @cancel="cancel"
  >
    <MinecraftJavaForm ref="formRef" v-model:data="minecraftJava" />
  </a-modal>
</template>
