<script setup lang="ts">
import { store } from '../store'
import FileManager from '../components/FileManager.vue'

const icon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>'
</script>

<template>
  <div class="ai-mod-entry"><div><strong>Numen AI 陪玩</strong><span>安装同伴模组、配置模型，在游戏里一起探索。</span></div><button class="btn btn-ghost" @click="store.currentView = 'ai'">打开 AI 陪玩 →</button></div>
  <FileManager
    title="模组"
    rel="mods"
    open-label="打开模组文件夹"
    empty-text="暂无模组，将 .jar 文件放入 mods 文件夹"
    :icon="icon"
  />
</template>

<style scoped>
.ai-mod-entry{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px;padding:14px 18px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface-content)}.ai-mod-entry>div{display:grid;gap:4px}.ai-mod-entry strong{font-size:13px}.ai-mod-entry span{font-size:12px;color:var(--text-dim)}@media(max-width:650px){.ai-mod-entry{align-items:flex-start;flex-direction:column}}
</style>
