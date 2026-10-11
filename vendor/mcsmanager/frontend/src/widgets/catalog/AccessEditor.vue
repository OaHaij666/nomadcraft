<script setup lang="ts">
import { ref, watch } from "vue";
import { cloneDeep } from "lodash";
import { ct } from "@/hooks/useCatalog";
import type {
  AccessGrant,
  CatalogPermission,
  CatalogUser,
  InstanceView
} from "@/services/apis/catalog";
const props = defineProps<{
  instance: InstanceView;
  users: CatalogUser[];
  editable: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ submit: [grants: AccessGrant[]] }>();
const grants = ref<AccessGrant[]>(cloneDeep(props.instance.grants));
watch(
  () => props.instance.revision,
  () => {
    grants.value = cloneDeep(props.instance.grants);
  }
);
const add = () =>
  grants.value.push({
    userId: "",
    scope: "instance",
    permissions: ["instance.read", "save.read"],
    hosting: false
  });
const capabilities: CatalogPermission[] = [
  "instance.read",
  "instance.update",
  "save.create",
  "save.read",
  "save.update",
  "save.delete",
  "room.manage",
  "mods.manage"
];
const scoped = (p: CatalogPermission) =>
  !["instance.update", "save.create", "mods.manage"].includes(p);
const changeScope = (grant: AccessGrant) => {
  if (grant.scope !== "instance") grant.permissions = grant.permissions.filter(scoped);
};
const preset = (grant: AccessGrant, role: string) => {
  const values: Record<string, CatalogPermission[]> = {
    viewer: ["instance.read", "save.read"],
    operator: ["instance.read", "save.read", "room.manage"],
    manager: capabilities
  };
  grant.permissions = values[role].filter((p) => grant.scope === "instance" || scoped(p));
};
const userName = (id: string) => props.users.find((u) => u.id === id)?.name ?? id;
</script>
<template>
  <section class="access-editor">
    <div class="section-heading">
      <div>
        <h2>{{ ct("ACCESS") }}</h2>
        <p>{{ ct("ACCESS_NOTE") }}</p>
      </div>
      <a-button v-if="editable" @click="add">+ {{ ct("ADD_MEMBER") }}</a-button>
    </div>
    <div class="owner-row">
      <strong>{{ ct("OWNER") }}</strong
      ><span>{{ instance.ownerName }}</span
      ><a-tag>{{ ct("FULL_CONTROL") }}</a-tag>
    </div>
    <a-empty v-if="!grants.length" :description="ct('NO_MEMBERS')" />
    <article v-for="(grant, index) in grants" :key="index" class="grant-card">
      <div class="grant-top">
        <a-select
          v-if="editable"
          v-model:value="grant.userId"
          :placeholder="ct('SELECT_USER')"
          :options="
            users
              .filter((u) => u.id !== instance.ownerId)
              .map((u) => ({ value: u.id, label: u.name }))
          "
          show-search
          :filter-option="
            (input: string, option: any) =>
              String(option.label).toLowerCase().includes(input.toLowerCase())
          "
        /><strong v-else>{{ userName(grant.userId) }}</strong>
        <a-select v-model:value="grant.scope" :disabled="!editable" @change="changeScope(grant)"
          ><a-select-option value="instance">{{ ct("INSTANCE_SCOPE") }}</a-select-option
          ><a-select-option v-for="save in instance.saves" :key="save.id" :value="save.id">{{
            save.name
          }}</a-select-option></a-select
        >
        <a-select
          v-if="editable"
          :placeholder="ct('ROLE_PRESET')"
          @change="(value) => preset(grant, String(value))"
          ><a-select-option value="viewer">{{ ct("ROLE_viewer") }}</a-select-option
          ><a-select-option value="operator">{{ ct("ROLE_operator") }}</a-select-option
          ><a-select-option value="manager">{{ ct("ROLE_manager") }}</a-select-option></a-select
        >
        <a-button v-if="editable" danger type="text" @click="grants.splice(index, 1)">{{
          ct("REMOVE")
        }}</a-button>
      </div>
      <a-checkbox-group
        v-model:value="grant.permissions"
        class="permission-grid"
        :disabled="!editable"
        ><a-checkbox
          v-for="permission in capabilities.filter((p) => grant.scope === 'instance' || scoped(p))"
          :key="permission"
          :value="permission"
          >{{ ct("PERM_" + permission.replace(".", "_")) }}</a-checkbox
        ></a-checkbox-group
      >
      <div class="hosting-row">
        <a-checkbox v-model:checked="grant.hosting" :disabled="!editable">{{
          ct("HOSTING_ALLOW")
        }}</a-checkbox
        ><span>{{ ct("HOSTING_NO_ADMIN") }}</span>
      </div>
    </article>
    <a-button
      v-if="editable"
      type="primary"
      :loading="busy"
      :disabled="grants.some((g) => !g.userId)"
      @click="emit('submit', grants)"
      >{{ ct("SAVE_ACCESS") }}</a-button
    >
    <p class="policy-note">{{ ct("ACCESS_OWNER_NOTE") }}</p>
  </section>
</template>
<style scoped>
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}
.section-heading h2 {
  font-size: 18px;
  margin: 0 0 10px;
}
.section-heading p,
.policy-note {
  color: var(--nc-mist);
  font-size: 13px;
  line-height: 1.8;
  margin: 0;
}
.owner-row {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 18px;
  border: var(--nc-hairline);
  border-radius: 8px;
  margin-bottom: 20px;
  font-size: 13px;
}
.grant-card {
  padding: 20px;
  border: var(--nc-hairline);
  border-radius: 10px;
  margin-bottom: 16px;
}
.grant-top {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.grant-top :deep(.ant-select) {
  min-width: 170px;
  flex: 1;
}
.permission-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.hosting-row {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  border-top: var(--nc-hairline);
  padding-top: 16px;
}
.hosting-row > span {
  font-size: 12px;
  color: var(--nc-mist);
}
.policy-note {
  margin-top: 20px;
}
@media (max-width: 800px) {
  .permission-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .section-heading {
    align-items: flex-start;
  }
}
</style>
