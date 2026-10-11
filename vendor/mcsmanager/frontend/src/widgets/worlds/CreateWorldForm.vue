<script setup lang="ts">
import { getFileConfigAddr } from "@/hooks/useFileManager";
import { INSTANCE_TYPE_TRANSLATION, TYPE_MINECRAFT_JAVA } from "@/hooks/useInstance";
import { WORLD_SOURCE } from "@/types/world";
import { t } from "@/lang/i18n";
import { createInstance as createInstanceApi, uploadAddress } from "@/services/apis/instance";
import uploadService, { UploadFiles } from "@/services/uploadService";
import { parseForwardAddress } from "@/tools/protocol";
import { reportErrorMsg } from "@/tools/validator";
import { defaultInstanceInfo } from "@/types/const";
import { UploadOutlined } from "@ant-design/icons-vue";
import type { FormInstance } from "ant-design-vue";
import { message, type UploadProps } from "ant-design-vue";
import type { Rule } from "ant-design-vue/es/form";
import { computed, onUnmounted, reactive, ref } from "vue";
import SelectUnzipCode from "@/widgets/instance/dialogs/SelectUnzipCode.vue";

const selectUnzipCodeDialog = ref<InstanceType<typeof SelectUnzipCode>>();
const emit = defineEmits(["nextStep"]);

const props = defineProps<{
  createMethod: WORLD_SOURCE;
  daemonId: string;
}>();

const zipCode = ref("utf-8");
const formRef = ref<FormInstance>();
const formData = reactive<IGlobalInstanceConfig>({
  ...structuredClone(defaultInstanceInfo),
  type: TYPE_MINECRAFT_JAVA,
  stopCommand: "stop",
  startCommand:
    props.createMethod === WORLD_SOURCE.FILE
      ? 'java -Xmx4G -jar "${ProgramName}" nogui'
      : "java -Xmx4G -jar server.jar nogui"
});
const minecraftTypes = Object.fromEntries(
  Object.entries(INSTANCE_TYPE_TRANSLATION).filter(([key]) => key.startsWith("minecraft/java"))
);

const isImportMode = props.createMethod === WORLD_SOURCE.IMPORT;
const isFileMode = props.createMethod === WORLD_SOURCE.FILE;
const needUpload = isImportMode || isFileMode;

const rules: Record<string, Rule[]> = {
  nickname: [{ required: true, message: t("TXT_CODE_68a504b3") }],
  stopCommand: [{ required: true, message: t("TXT_CODE_83053cd5") }],
  startCommand: [{ required: true, message: t("TXT_CODE_83053cd5") }],
  cwd: [{ required: props.createMethod === WORLD_SOURCE.EXIST, message: t("TXT_CODE_71c948a9") }]
};

const uFile = ref<File>();

const beforeUpload: UploadProps["beforeUpload"] = async (file) => {
  if (uploadFileInstance.value) return false;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if ((isImportMode && extension !== "zip") || (isFileMode && extension !== "jar")) {
    reportErrorMsg(t("TXT_CODE_WORLD_INVALID_FILE"));
    return false;
  }
  uFile.value = file;

  if (isImportMode) {
    const extName = file.name.split(".").pop()?.toLowerCase() || "";
    if (!["zip"].includes(extName)) return reportErrorMsg(t("TXT_CODE_808e5ad9"));
    selectUnzipCodeDialog.value?.openDialog();
  } else {
    finalConfirm();
  }

  return false;
};

const setUnzipCode = async (code: string) => {
  zipCode.value = code;
  finalConfirm();
};

const finalConfirm = async () => {
  try {
    await formRef.value?.validate();
  } catch (err: any) {
    return reportErrorMsg(t("TXT_CODE_47e21c80"));
  }
  try {
    if (needUpload) await selectedFile();
    else await createInstance();
  } catch (error) {
    reportErrorMsg(error);
  }
};

const uploadStarted = ref(false);
const uploadFileInstance = ref<UploadFiles>();
let uploadStartCallback: (() => void) | undefined = undefined;
let uploadEndCallback: (() => void) | undefined = undefined;
onUnmounted(() => {
  if (uploadFileInstance.value) {
    if (uploadStartCallback) uploadFileInstance.value.removeCallback("start", uploadStartCallback);
    if (uploadEndCallback) uploadFileInstance.value.removeCallback("end", uploadEndCallback);
  }
});

const { state: cfg, execute: getCfg } = uploadAddress();
const percentComplete = computed(() => {
  if (!uploadStarted.value) return 0;
  const uploadData = uploadService.uiData.value;
  if (!uploadData.current) return 0;
  return (uploadData.current[0] / uploadData.current[1]) * 100;
});

const percentText = () => {
  if (!uploadFileInstance.value) {
    return t("TXT_CODE_c17f6488");
  }

  if (uploadStarted.value) {
    return t("TXT_CODE_b625dbf0") + percentComplete.value.toFixed(0) + "%";
  } else {
    return t("TXT_CODE_f63c4be2", {
      n: uploadService.getFileNth(uploadFileInstance.value.id || "")
    });
  }
};

const selectedFile = async () => {
  try {
    if (!formData.cwd) formData.cwd = ".";
    if (formData.docker.image) formData.processType = "docker";
    if (isFileMode)
      formData.startCommand = formData.startCommand.replace("${ProgramName}", uFile.value!.name);
    await getCfg({
      params: {
        upload_dir: ".",
        daemonId: props.daemonId
      },
      data: formData
    });
    if (!cfg.value) throw new Error(t("TXT_CODE_e8ce38c2"));

    uploadStartCallback = () => {
      uploadStarted.value = true;
    };
    const addr = parseForwardAddress(getFileConfigAddr(cfg.value), "http");
    const task = uploadService.append(
      uFile.value!,
      addr,
      cfg.value.password,
      {
        overwrite: false,
        unzip: isImportMode,
        code: zipCode.value
      },
      (task) => {
        task.addCallback("start", uploadStartCallback!);
      }
    );
    uploadFileInstance.value = task;
    const instanceUuid = cfg.value.instanceUuid;
    uploadEndCallback = () => {
      if (task.canceled || task.removing) {
        uploadStarted.value = false;
        uploadFileInstance.value = undefined;
        return;
      }
      emit("nextStep", instanceUuid);
      return message.success(t("TXT_CODE_d28c05df"));
    };
    task.addCallback("end", uploadEndCallback);
  } catch (err: any) {
    console.error(err);
    return reportErrorMsg(err.message);
  }
};

const {
  state: newInstanceInfo,
  execute: executeCreateInstance,
  isLoading: createInstanceLoading
} = createInstanceApi();
const createInstance = async () => {
  try {
    if (!formData.cwd) formData.cwd = ".";
    if (formData.docker.image) formData.processType = "docker";
    await executeCreateInstance({
      params: {
        daemonId: props.daemonId
      },
      data: formData
    });
    if (newInstanceInfo.value) emit("nextStep", newInstanceInfo.value.instanceUuid);
    return message.success(t("TXT_CODE_d28c05df"));
  } catch (err: any) {
    return reportErrorMsg(err.message);
  }
};
</script>

<template>
  <a-form ref="formRef" :rules="rules" :model="formData" layout="vertical" autocomplete="off">
    <a-row :gutter="20">
      <a-col :xs="24" :md="12">
        <a-form-item name="nickname" :label="t('TXT_CODE_WORLD_NAME')">
          <a-input
            v-model:value="formData.nickname"
            :placeholder="t('TXT_CODE_WORLD_NAME_PLACEHOLDER')"
          />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :md="12">
        <a-form-item :label="t('TXT_CODE_WORLD_SERVER_TYPE')">
          <a-select v-model:value="formData.type">
            <a-select-option v-for="(label, key) in minecraftTypes" :key="key" :value="key">
              {{
                label
              }}
            </a-select-option>
          </a-select>
        </a-form-item>
      </a-col>
    </a-row>
    <a-form-item
      v-if="createMethod === WORLD_SOURCE.EXIST"
      name="cwd"
      :label="t('TXT_CODE_WORLD_DIRECTORY')"
    >
      <a-input v-model:value="formData.cwd" />
    </a-form-item>
    <a-form-item name="startCommand" :label="t('TXT_CODE_d12fa808')">
      <a-input v-model:value="formData.startCommand" />
    </a-form-item>
    <a-form-item name="stopCommand" :label="t('TXT_CODE_11cfe3a1')">
      <a-input v-model:value="formData.stopCommand" />
    </a-form-item>
    <a-form-item v-if="needUpload">
      <p class="source-note">
        {{ t(isFileMode ? "TXT_CODE_WORLD_JAR_NOTE" : "TXT_CODE_WORLD_ARCHIVE_NOTE") }}
      </p>
      <a-upload
        :accept="isFileMode ? '.jar' : '.zip'"
        :before-upload="beforeUpload"
        :max-count="1"
        :show-upload-list="false"
        :disabled="uploadFileInstance !== undefined"
      >
        <a-button type="primary" :loading="uploadFileInstance !== undefined">
          <UploadOutlined />
          {{
            uploadFileInstance
              ? percentText()
              : t(isFileMode ? "TXT_CODE_WORLD_UPLOAD_JAR" : "TXT_CODE_WORLD_UPLOAD_ARCHIVE")
          }}
        </a-button>
      </a-upload>
      <a-progress v-if="uploadStarted" :percent="Math.round(percentComplete)" />
    </a-form-item>
    <a-button v-else type="primary" :loading="createInstanceLoading" @click="finalConfirm">
      {{
        t("TXT_CODE_WORLD_CREATE")
      }}
    </a-button>
  </a-form>
  <SelectUnzipCode ref="selectUnzipCodeDialog" @select-code="setUnzipCode" />
</template>
<style scoped>
.source-note {
  color: var(--nc-mist);
  font-size: 13px;
}
</style>
