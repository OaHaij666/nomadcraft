<script setup lang="ts">
import { t } from "@/lang/i18n";
import { ExclamationCircleOutlined } from "@ant-design/icons-vue";
defineProps<{ title: string; error: Error }>();
</script>

<template>
  <CardPanel>
    <template #title>{{ title }}</template>
    <template #body>
      <a-typography-paragraph>
        <ExclamationCircleOutlined /> {{ t("TXT_CODE_4e627613") }}
      </a-typography-paragraph>
      <pre>{{ error.message }}</pre>
    </template>
  </CardPanel>
</template>
