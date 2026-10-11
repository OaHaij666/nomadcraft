<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { nomadStatus, nomadWebToken, selectDir, getSettings } from '../api'
import { openNomadCenter, store } from '../store'

const storageReady = ref(false)
const storagePath = ref('')
const storageError = ref('')
const choosing = ref(false)
const loading = ref(true)
const error = ref('')
const panelUrl = ref('')
const iframeTitle = '实例中心'
function routeUrl(path: string, token: string, address: string) {
  // The HTML/JS/CSS is bundled with KAMUCL. Only API traffic goes to the
  // configured NomadCraft server.
  const query = `nomadToken=${encodeURIComponent(token)}&nomadAddress=${encodeURIComponent(address)}`
  return `kamucl-panel://local/#${path}?${query}`
}

async function load() {
  loading.value = true; error.value = ''
  try {
    const session = await nomadWebToken()
    const status = await nomadStatus()
    if (!session.token || !session.address || !status.signedIn) {
      error.value = '云端会话已失效，请回到多人游戏重新登录。'
      return
    }
    const storage = await window.kamucl.invoke('nomad:storage') as { path: string; valid: boolean }
    storageReady.value = storage.valid
    storagePath.value = storage.path
    panelUrl.value = routeUrl('/catalog', session.token, session.address)
  } catch (e) { error.value = String(e) }
  finally { loading.value = false }
}
async function chooseStorage() {
  choosing.value=true;storageError.value=''
  try {
    const selected=await selectDir();if(!selected)return
    const result=await window.kamucl.invoke('nomad:setStorage',selected) as {path:string;valid:boolean}
    storagePath.value=result.path;storageReady.value=result.valid
    store.settings=await getSettings()
  } catch(e){storageError.value=String(e)}
  finally{choosing.value=false}
}
function onFrameLoad() { loading.value = false }
function goLogin() { openNomadCenter() }
onMounted(() => { void load() })
</script>

<template>
  <section class="cloud-panel-page">
    <div v-if="error" class="cloud-panel-error"><span>{{ error }}</span><button class="btn btn-primary btn-sm" @click="goLogin">前往登录</button></div>
    <div v-else-if="!loading&&!storageReady" class="cloud-storage-setup">
      <article><span class="setup-mark">NC</span><h1>设置云端实例的本地存放位置</h1><p>云端实例也需要本地空间保存游戏文件。先选择这台电脑上的存放文件夹，再进入实例中心。</p><label>本地目录<div>{{storagePath||'尚未选择文件夹'}}</div></label><small>此设置只保存在本机；各个云端实例仍可绑定具体的本地客户端。</small><p v-if="storageError" class="storage-error" role="alert">{{storageError}}</p><button class="btn btn-primary" :disabled="choosing" @click="chooseStorage">{{choosing?'正在选择…':'选择文件夹并进入实例中心'}}</button></article>
    </div>
    <div v-else class="cloud-panel-frame-wrap"><div v-if="loading" class="cloud-panel-loading">正在加载{{ iframeTitle }}…</div><iframe v-if="panelUrl&&storageReady" class="cloud-panel-frame" :src="panelUrl" :title="`NomadCraft ${iframeTitle}`" @load="onFrameLoad" /></div>
  </section>
</template>

<style scoped>
.cloud-panel-page{position:relative;width:100%;height:100%;min-height:0;background:var(--surface-content);color:var(--text)}
.cloud-panel-frame-wrap{position:absolute;inset:0;background:#fff;overflow:hidden}
.cloud-panel-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:#fff}
.cloud-panel-loading{position:absolute;inset:0;z-index:1;display:grid;place-items:center;background:var(--surface-content);color:var(--text-dim);font-size:13px}
.cloud-panel-error{display:flex;align-items:center;justify-content:center;gap:12px;height:100%;padding:30px;color:var(--danger);font-size:13px}
.btn{cursor:pointer;border:0;border-radius:8px;padding:8px 11px;color:inherit;font:inherit}.btn-primary{background:var(--accent-grad);color:var(--on-accent);font-weight:700}.btn-sm{font-size:12px}
.cloud-storage-setup{display:grid;place-items:center;min-height:100%;padding:32px;box-sizing:border-box;overflow:auto}.cloud-storage-setup article{box-sizing:border-box;width:min(540px,100%);padding:30px;border:1px solid var(--border);border-radius:18px;background:var(--card);box-shadow:var(--shadow-lg)}.setup-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--accent-grad);color:var(--on-accent);font-size:15px;font-weight:900}.cloud-storage-setup h1{font-size:23px;line-height:1.4;margin:20px 0 12px}.cloud-storage-setup p{color:var(--text-dim);font-size:13px;line-height:1.85;margin:0 0 20px}.cloud-storage-setup label{display:grid;gap:8px;font-size:12px;color:var(--text-dim)}.cloud-storage-setup label>div{padding:12px;border:1px solid var(--border);background:var(--card-2);border-radius:9px;overflow-wrap:anywhere;color:var(--text)}.cloud-storage-setup small{display:block;margin:12px 0 22px;color:var(--text-dim);font-size:11px;line-height:1.75}.cloud-storage-setup .btn{padding:12px 16px;width:100%;border-radius:9px;font-size:13px}.cloud-storage-setup .storage-error{color:var(--danger)}
</style>
