<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ seed: string }>();
const palette = computed(() => {
  const colors = [
    ["#25283e", "#555b73", "#343e52", "#233937", "#829d7c"],
    ["#2e2839", "#796e88", "#484258", "#363748", "#a095b5"],
    ["#253039", "#6a8791", "#405a62", "#31464b", "#92aaa3"]
  ];
  return colors[
    Array.from(props.seed).reduce((sum, c) => sum + c.charCodeAt(0), 0) % colors.length
  ];
});
</script>
<template>
  <svg
    viewBox="0 0 480 150"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
    class="world-artwork"
  >
    <rect width="480" height="150" :fill="palette[0]" />
    <rect x="356" y="24" width="23" height="23" fill="#e5dfcd" opacity=".65" />
    <path
      d="M0 92H48V75H92V59H134V76H172V87H214V66H250V43H290V65H332V82H370V60H415V80H480V150H0Z"
      :fill="palette[1]"
      opacity=".45"
    />
    <path
      d="M0 117H32V101H76V111H119V90H160V107H202V94H242V112H285V91H326V112H368V96H410V107H450V87H480V150H0Z"
      :fill="palette[2]"
    />
    <path
      d="M0 132H61V120H115V128H179V118H237V129H305V116H361V125H426V114H480V150H0Z"
      :fill="palette[3]"
    />
    <path
      d="M24 112H44V128H24Z M20 92H48V112H20Z M29 83H40V92H29Z M412 97H446V117H412Z M420 85H438V97H420Z"
      :fill="palette[4]"
      opacity=".7"
    />
    <rect x="31" y="112" width="7" height="20" :fill="palette[3]" />
    <rect x="426" y="115" width="7" height="15" :fill="palette[3]" />
  </svg>
</template>
<style scoped>
.world-artwork {
  display: block;
  width: 100%;
  height: 138px;
}
</style>
