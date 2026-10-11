<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { addFolder, getInstalled, getSettings, nomadCatalog, nomadConnect, nomadCreateOfficial, nomadCreateSave, nomadLogin, nomadLogout, nomadRoom, nomadStatus, selectDir } from '../api'
import type { NomadCatalog, NomadCatalogInstance, NomadCatalogSave, NomadPermission, NomadStatus } from '../api'
import type { InstalledVersion } from '@shared/types'
import { cloudSyncText, cloudSyncTone, refreshCloudInstances, setCloudInstanceBinding, store, toast } from '../store'
import type { CloudInstalledVersion } from '../store'

const props = defineProps<{ loginOnly?: boolean }>()

const address = ref('')
const username = ref('')
const password = ref('')
const code = ref('')
const status = ref<NomadStatus>({ address: '', connected: false, signedIn: false })
const catalog = ref<NomadCatalog | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const query = ref('')
const loaderFilter = ref('')
const selectedId = ref('')
const selectedSaveId = ref('')
const detailTab = ref<'overview' | 'saves' | 'permissions' | 'network'>('overview')
const createOpen = ref(false)
const saveOpen = ref(false)
const newInstanceName = ref('')
const newInstanceVersion = ref('1.21.4')
const newSaveName = ref('新存档')
const newSaveDescription = ref('')

const connectedLabel = computed(() => status.value.signedIn ? '已登录' : status.value.connected ? '已配置服务地址' : '未连接')
const instances = computed(() => catalog.value?.instances ?? [])
const filteredInstances = computed(() => instances.value.filter(instance => {
  const profile = instance.profile ?? {}
  const text = [instance.name, instance.ownerName, profile.mcVersion, profile.loader, profile.packName].filter(Boolean).join(' ').toLowerCase()
  return (!query.value.trim() || text.includes(query.value.trim().toLowerCase())) && (!loaderFilter.value || profile.loader === loaderFilter.value)
}))
const selectedInstance = computed<NomadCatalogInstance | null>(() => instances.value.find(instance => instance.id === selectedId.value) ?? filteredInstances.value[0] ?? instances.value[0] ?? null)
const selectedSave = computed<NomadCatalogSave | null>(() => selectedInstance.value?.saves?.find(save => save.id === selectedSaveId.value) ?? selectedInstance.value?.saves?.[0] ?? null)
const selectedCloudProjection = computed<CloudInstalledVersion | null>(() => {
  const instance = selectedInstance.value
  if (!instance) return null
  const saveId = selectedSave.value?.id
  return store.cloudInstances.find(value => value.cloudInstanceId === instance.id && (value.cloudSaveId === saveId || (!value.cloudSaveId && !saveId))) ?? null
})
const localClientChoice = ref('')
const localClients = ref<InstalledVersion[]>([])
async function refreshLocalClients() {
  try { localClients.value = (await getInstalled(true)).filter(version => !version.incomplete && !version.failed) } catch { localClients.value = store.installed.filter(version => !version.incomplete && !version.failed) }
}
const localFolderLabel = (folder: string) => {
  const normalized = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const registered = store.settings?.folders.find(item => item.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === normalized)
  if (registered?.name) return registered.name
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]+/)
  return parts.at(-1) || folder
}
const localClientChoiceOf = (version: { id: string; folder: string }) => `${version.folder}\n${version.id}`
function cloudProjectionFor(instance: NomadCatalogInstance) {
  return store.cloudInstances.find(value => value.cloudInstanceId === instance.id) ?? null
}
watch(selectedCloudProjection, value => {
  localClientChoice.value = value?.cloudLocalVersionId && value.cloudLocalFolder
    ? localClientChoiceOf({ id: value.cloudLocalVersionId, folder: value.cloudLocalFolder })
    : ''
}, { immediate: true })
async function bindSelectedCloudClient(choice = localClientChoice.value) {
  const instance = selectedInstance.value
  const projection = selectedCloudProjection.value
  if (!instance || !projection) return
  const [folder, versionId] = choice.split('\n')
  if (!folder) {
    await setCloudInstanceBinding(instance.id, projection.cloudSaveId, null)
    localClientChoice.value = ''
    notice.value = '已解除本地客户端绑定。'
    return
  }
  await setCloudInstanceBinding(instance.id, projection.cloudSaveId, { localFolder: folder, localVersionId: versionId || undefined })
  notice.value = versionId ? '已绑定本地客户端实例，等待同步检查。' : '已绑定本地目录，尚未指定本地客户端版本。'
}
async function pickLocalCloudDirectory() {
  const instance = selectedInstance.value
  const projection = selectedCloudProjection.value
  if (!instance || !projection) return
  const selected = await selectDir()
  if (!selected) return
  try {
    const normalized = selected.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    if (!store.settings?.folders.some(item => item.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === normalized)) {
      await addFolder(selected)
      store.settings = await getSettings()
    }
    await refreshLocalClients()
    const local = localClients.value.find(version => version.folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === normalized)
    await setCloudInstanceBinding(instance.id, projection.cloudSaveId, { localFolder: selected, localVersionId: local?.id })
    localClientChoice.value = local ? localClientChoiceOf(local) : ''
    notice.value = local ? '已绑定本地客户端实例，等待同步检查。' : '目录已登记，但其中还没有可绑定的本地客户端版本。'
  } catch (e) { error.value = String(e) }
}

const totalSaves = computed(() => instances.value.reduce((count, instance) => count + (instance.saves?.length ?? 0), 0))
const totalRooms = computed(() => instances.value.reduce((count, instance) => count + (instance.saves ?? []).filter(save => !!save.room).length, 0))
const manageableInstances = computed(() => instances.value.filter(instance => hasPermission(instance, 'instance.update') || hasPermission(instance, 'room.manage')).length)
const permissionLabels: Record<string, string> = {
  'instance.read': '查看实例', 'instance.update': '修改实例', 'save.create': '创建存档', 'save.read': '查看存档',
  'save.update': '修改存档', 'save.delete': '删除存档', 'room.manage': '管理房间', 'members.manage': '管理成员',
  'mods.manage': '管理服务端 MOD', 'players.manage': '管理玩家'
}
const loaderLabel = (loader?: string) => !loader || loader === 'vanilla' ? '原版' : loader
const profileText = (instance: NomadCatalogInstance) => {
  const profile = instance.profile ?? {}
  return [profile.mcVersion || '版本待配置', loaderLabel(profile.loader), profile.loaderVersion].filter(Boolean).join(' · ')
}
const instancePermissions = computed(() => selectedInstance.value?.permissions ?? [])
const savePermissions = computed(() => selectedInstance.value?.savePermissions?.[selectedSave.value?.id ?? ''] ?? [])
const allPermissions = computed(() => [...new Set([...instancePermissions.value, ...savePermissions.value])])

function hasPermission(instance: NomadCatalogInstance, permission: NomadPermission, save?: NomadCatalogSave | null) {
  return instance.permissions?.includes(permission) || (save ? instance.savePermissions?.[save.id]?.includes(permission) : false) || false
}
function permissionLabel(permission: string) { return permissionLabels[permission] ?? permission }
function roomLabel(save: NomadCatalogSave) {
  if (!save.room) return '未创建房间'
  if (save.room.desiredState === 'open') return save.hosting?.phase === 'running' ? '运行中' : '房间已开启'
  return '房间已关闭'
}
function roomTone(save: NomadCatalogSave) {
  if (!save.room) return 'muted'
  return save.room.desiredState === 'open' ? 'online' : 'muted'
}
function hostingLabel(save: NomadCatalogSave) {
  if (!save.hosting) return '等待计算节点'
  return save.hosting.phase || (save.hosting.joinAddress ? '已分配节点' : '节点准备中')
}
function selectInstance(id: string) {
  selectedId.value = id
  selectedSaveId.value = ''
  detailTab.value = 'overview'
}
function selectSave(save: NomadCatalogSave) { selectedSaveId.value = save.id; detailTab.value = 'saves' }
async function copyRoomAddress(save: NomadCatalogSave) {
  const address = save.hosting?.joinAddress
  if (!address) { notice.value = '当前房间还没有可用连接地址。'; return }
  try { await navigator.clipboard.writeText(address); notice.value = '房间地址已复制。' }
  catch { notice.value = address }
}
function openLocalSettings() { store.currentView = 'settings' }
async function createInstance() {
  if (!newInstanceName.value.trim() || !newInstanceVersion.value.trim()) { error.value = '请填写实例名称和 Minecraft 版本'; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await nomadCreateOfficial({ version: newInstanceVersion.value.trim(), name: newInstanceName.value.trim() })
    createOpen.value = false; newInstanceName.value = ''; await refreshCatalog(); if (result?.id) selectInstance(result.id); notice.value = '云端实例创建成功。'
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function createSave() {
  if (!selectedInstance.value || !newSaveName.value.trim()) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await nomadCreateSave(selectedInstance.value.id, { name: newSaveName.value.trim(), description: newSaveDescription.value.trim() }); saveOpen.value = false; await refreshCatalog(); notice.value = '云端存档创建成功。' }
  catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function toggleRoom(save: NomadCatalogSave) {
  if (!selectedInstance.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const exists = !!save.room
    await nomadRoom(selectedInstance.value.id, save.id, { name: save.room?.name || save.name, desiredState: exists && save.room?.desiredState === 'open' ? 'closed' : 'open' }, !exists)
    await refreshCatalog(); notice.value = exists && save.room?.desiredState === 'open' ? '房间已关闭。' : '房间已开启，正在等待计算节点。'
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}

function finishCloudAuthRedirect() {
  if (!props.loginOnly || !status.value.signedIn || !store.nomadReturnToCloud) return
  store.nomadReturnToCloud = false
  store.nomadEntryRequested = false
  store.currentView = 'cloud'
}
async function refreshStatus() {
  status.value = await nomadStatus()
  address.value = status.value.address
  if (status.value.signedIn) await refreshCatalog()
  finishCloudAuthRedirect()
}
async function connect() {
  busy.value = true; error.value = ''; notice.value = ''
  try { status.value = await nomadConnect(address.value); notice.value = '服务地址已保存。'; await refreshCatalog() }
  catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function login() {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    status.value = await nomadLogin(address.value, username.value, password.value, code.value)
    password.value = ''
    await refreshCatalog()
    await refreshCloudInstances()
    notice.value = '已连接 NomadCraft 控制面。'
    finishCloudAuthRedirect()
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function refreshCatalog() {
  if (!status.value.signedIn) { catalog.value = null; return }
  busy.value = true; error.value = ''
  try {
    catalog.value = await nomadCatalog()
    if (!selectedId.value || !catalog.value.instances.some(instance => instance.id === selectedId.value)) selectedId.value = catalog.value.instances[0]?.id ?? ''
    await refreshCloudInstances()
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function logout() {
  status.value = await nomadLogout(); catalog.value = null; selectedId.value = ''; await refreshCloudInstances(); notice.value = '已退出 NomadCraft 会话。'
}
watch(selectedInstance, instance => { if (instance && !instance.saves?.some(save => save.id === selectedSaveId.value)) selectedSaveId.value = instance.saves?.[0]?.id ?? '' })
onMounted(() => { void refreshLocalClients(); void refreshStatus() })
</script>

<template>
  <section class="nomad-page">
    <header class="nomad-heading">
      <div>
        <p class="eyebrow">NOMADCRAFT / CLOUD CONTROL</p>
        <h1>云端实例中心</h1>
        <p class="muted">统一管理逻辑实例、云端存档、房间权限和计算节点。</p>
      </div>
      <div class="heading-actions">
        <span class="status-pill" :class="{ online: status.signedIn }"><i></i>{{ connectedLabel }}</span>
        <button class="btn btn-ghost" :disabled="busy" @click="refreshStatus">刷新</button>
      </div>
    </header>

    <div v-if="error" class="message error" role="alert">{{ error }}</div>
    <div v-if="notice" class="message success" role="status">{{ notice }}</div>

    <section v-if="!status.signedIn" class="connect-layout">
      <article class="panel-card connect-card">
        <div class="section-heading"><div><h2>连接控制面</h2><p class="muted">启动器只保存服务地址和会话，实例数据由 NomadCraft 控制面管理。</p></div></div>
        <label>服务地址<input v-model="address" placeholder="https://mc.example.com" autocomplete="url" /></label>
        <div class="button-row"><button class="btn btn-primary" :disabled="busy || !address" @click="connect">保存地址</button></div>
        <div class="separator"><span>登录控制面</span></div>
        <label>社区账号<input v-model="username" autocomplete="username" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
        <label>二步验证码（可选）<input v-model="code" inputmode="numeric" autocomplete="one-time-code" /></label>
        <button class="btn btn-primary full" :disabled="busy || !address || !username || !password" @click="login">{{ busy ? '连接中…' : '登录 NomadCraft' }}</button>
      </article>
      <article class="panel-card cloud-intro">
        <span class="cloud-mark">NC</span><h2>云端逻辑主机</h2>
        <p class="muted">实例和存档放在控制面，房间可以使用服务器节点或玩家节点计算。玩家只需进入固定的 NomadCraft 房间入口。</p>
        <div class="intro-points"><span>✓ 实例与存档统一管理</span><span>✓ 权限绑定到实例和存档</span><span>✓ 房主交接不改变逻辑房间</span><span>✓ 本地资源与云端资源分开</span></div>
        <button class="btn btn-ghost" @click="openLocalSettings">查看启动器设置</button>
      </article>
    </section>

    <template v-else-if="!props.loginOnly">
      <section class="cloud-stats">
        <div class="stat-card"><span>逻辑实例</span><strong>{{ instances.length }}</strong><small>当前账号可见</small></div>
        <div class="stat-card"><span>云端存档</span><strong>{{ totalSaves }}</strong><small>按实例归属</small></div>
        <div class="stat-card"><span>房间</span><strong>{{ totalRooms }}</strong><small>已创建房间</small></div>
        <div class="stat-card"><span>可管理</span><strong>{{ manageableInstances }}</strong><small>拥有管理权限</small></div>
      </section>

      <section class="cloud-workspace">
        <article class="panel-card instance-catalog">
          <div class="section-heading"><div><h2>我的云端实例</h2><p class="muted">选择实例后查看存档、房间和权限。</p></div><div class="section-actions"><button v-if="catalog?.canCreate" class="btn btn-primary" :disabled="busy" @click="createOpen=true">创建实例</button><button class="btn btn-ghost" :disabled="busy" @click="refreshCatalog">{{ busy ? '刷新中…' : '刷新目录' }}</button></div></div>
          <div class="catalog-tools"><input v-model="query" placeholder="搜索实例、版本或整合包…" aria-label="搜索云端实例" /><select v-model="loaderFilter" aria-label="按加载器筛选"><option value="">全部加载器</option><option value="vanilla">原版</option><option value="paper">Paper</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></div>
          <div v-if="!filteredInstances.length" class="empty">{{ instances.length ? '没有匹配的云端实例。' : '当前账号没有可用云端实例。' }}</div>
          <button v-for="instance in filteredInstances" :key="instance.id" class="logical-instance" :class="{ selected: instance.id === selectedInstance?.id }" @click="selectInstance(instance.id)">
            <span class="instance-mark">NC</span><span class="instance-copy"><strong>{{ instance.name || '未命名实例' }}</strong><small>{{ profileText(instance) }}</small><small>{{ instance.saves?.length ?? 0 }} 个存档 · {{ instance.ownerName || '当前账号' }}</small><small v-if="cloudProjectionFor(instance)" class="cloud-instance-sync" :class="cloudSyncTone(cloudProjectionFor(instance)!)">{{ cloudSyncText(cloudProjectionFor(instance)!) }}<template v-if="cloudProjectionFor(instance)?.folder"> · {{ localFolderLabel(cloudProjectionFor(instance)!.folder) }}</template></small></span><span class="instance-arrow">›</span>
          </button>
        </article>

        <article v-if="selectedInstance" class="panel-card instance-detail">
          <header class="detail-heading"><div><p class="eyebrow">INSTANCE / {{ selectedInstance.id }}</p><h2>{{ selectedInstance.name || '未命名实例' }}</h2><p class="muted">{{ selectedInstance.description || '暂无实例说明。' }}</p></div><span class="revision">修订 {{ selectedInstance.revision ?? '—' }}</span></header>
          <nav class="detail-tabs" aria-label="云端实例详情"><button :class="{ active: detailTab === 'overview' }" @click="detailTab='overview'">概览</button><button :class="{ active: detailTab === 'saves' }" @click="detailTab='saves'">存档与房间</button><button :class="{ active: detailTab === 'network' }" @click="detailTab='network'">节点与网络</button><button :class="{ active: detailTab === 'permissions' }" @click="detailTab='permissions'">权限</button></nav>

          <div v-if="detailTab === 'overview'" class="detail-content">
            <div class="detail-grid"><div><small>游戏版本</small><strong>{{ profileText(selectedInstance) }}</strong></div><div><small>实例所有者</small><strong>{{ selectedInstance.ownerName || '当前账号' }}</strong></div><div><small>存档数量</small><strong>{{ selectedInstance.saves?.length ?? 0 }}</strong></div><div><small>当前权限</small><strong>{{ allPermissions.length }} 项</strong></div></div>
            <section v-if="selectedCloudProjection" class="local-binding-card">
              <header><div><small>本地客户端目录</small><strong>{{ selectedCloudProjection.folder ? localFolderLabel(selectedCloudProjection.folder) : '尚未绑定' }}</strong><span class="muted local-binding-path">{{ selectedCloudProjection.folder || '云端实例需要绑定本地客户端后才能管理本地资源。' }}</span></div><span class="sync-state" :class="cloudSyncTone(selectedCloudProjection)">{{ cloudSyncText(selectedCloudProjection) }}</span></header>
              <div class="local-binding-actions"><select v-model="localClientChoice" aria-label="选择云端实例的本地客户端" @change="bindSelectedCloudClient()"><option value="">选择已安装的本地客户端…</option><option v-for="client in localClients" :key="client.folder + '/' + client.id" :value="localClientChoiceOf(client)">{{ client.id }} · {{ client.mcVersion }} · {{ localFolderLabel(client.folder) }}</option></select><button class="btn btn-ghost btn-sm" @click="pickLocalCloudDirectory">选择本地目录</button><button v-if="selectedCloudProjection.folder" class="btn btn-ghost btn-sm" @click="bindSelectedCloudClient('')">解除绑定</button></div>
              <p v-if="selectedCloudProjection.cloudSyncMessage" class="muted local-binding-note">{{ selectedCloudProjection.cloudSyncMessage }}</p>
              <p class="muted local-binding-note">本地目录保存客户端文件、光影包和材质包；云端实例的存档、服务端配置和权限仍以控制面为准。</p>
            </section>

            <div class="selected-save" v-if="selectedSave"><div><small>最近选择的存档</small><strong>{{ selectedSave.name }}</strong><span class="muted">{{ roomLabel(selectedSave) }} · {{ hostingLabel(selectedSave) }}</span></div><button class="btn btn-primary" :disabled="!selectedSave.hosting?.joinAddress" @click="copyRoomAddress(selectedSave)">{{ selectedSave.hosting?.joinAddress ? '复制房间地址' : '等待节点' }}</button></div>
            <div v-else class="empty compact">这个实例还没有存档。</div>
            <div class="permission-summary"><small>当前账号权限</small><div><span v-for="permission in allPermissions" :key="permission" class="permission-pill">{{ permissionLabel(permission) }}</span><span v-if="!allPermissions.length" class="muted">暂无可用权限</span></div></div>
          </div>

          <div v-else-if="detailTab === 'saves'" class="detail-content"><div class="section-actions save-actions"><button v-if="hasPermission(selectedInstance, 'save.create')" class="btn btn-primary" @click="saveOpen=true">创建存档</button></div><div v-if="!selectedInstance.saves?.length" class="empty compact">暂无存档。</div><div v-else class="save-list"><div v-for="save in selectedInstance.saves" :key="save.id" class="save-row" :class="{ selected: save.id === selectedSave?.id }" @click="selectSave(save)"><span class="save-icon">▣</span><span><strong>{{ save.name }}</strong><small>{{ save.description || '暂无存档说明' }}</small></span><span class="save-status" :class="roomTone(save)">{{ roomLabel(save) }}<small>{{ hostingLabel(save) }}</small></span><button v-if="hasPermission(selectedInstance, 'room.manage', save)" class="btn btn-ghost btn-sm" :disabled="busy" @click.stop="toggleRoom(save)">{{ save.room?.desiredState === 'open' ? '关闭房间' : save.room ? '重新开启' : '创建房间' }}</button></div></div></div>

          <div v-else-if="detailTab === 'network'" class="detail-content"><div v-if="selectedSave" class="network-grid"><div><small>当前计算者</small><strong>{{ selectedSave.hosting?.nodeName || (selectedSave.hosting?.phase === 'running' ? '节点运行中' : '等待调度') }}</strong></div><div><small>运行阶段</small><strong>{{ hostingLabel(selectedSave) }}</strong></div><div><small>房间状态</small><strong>{{ roomLabel(selectedSave) }}</strong></div><div><small>连接地址</small><strong class="network-address">{{ selectedSave.hosting?.joinAddress || '暂未分配' }}</strong></div></div><div v-else class="empty compact">先选择一个存档，才能查看计算节点和网络状态。</div><div class="network-actions"><p class="muted">节点选择、IPv4/IPv6、穿透和中转状态由 NomadCraft 控制面统一决定；启动器只展示当前实例返回的结果。</p><button class="btn btn-ghost" :disabled="busy || !selectedSave" @click="refreshCatalog">重新读取节点状态</button></div></div>

          <div v-else class="detail-content"><div class="owner-line"><span class="instance-mark small">NC</span><span><small>实例所有者</small><strong>{{ selectedInstance.ownerName || '当前账号' }}</strong></span><span class="permission-pill strong">完全控制</span></div><div class="permission-grid"><span v-for="permission in allPermissions" :key="permission" class="permission-card"><strong>{{ permissionLabel(permission) }}</strong><small>{{ permission }}</small></span><span v-if="!allPermissions.length" class="empty compact">控制面没有返回权限信息。</span></div><p class="muted permission-note">权限分别绑定到实例和存档。启动器只根据控制面返回的权限启用操作，不在本地推断权限。</p></div>
        </article>
        <article v-else class="panel-card instance-detail empty-detail"><span class="cloud-mark">NC</span><h2>选择一个云端实例</h2><p class="muted">登录控制面后，实例、存档和权限会显示在这里。</p></article>
      </section>
    </template>

    <div v-if="createOpen" class="modal-mask" @pointerdown.self="createOpen=false"><form class="modal-card" @submit.prevent="createInstance"><div class="section-heading"><div><h2>创建云端实例</h2><p class="muted">从 NomadCraft 官方版本目录创建逻辑实例。</p></div><button type="button" class="btn btn-ghost" @click="createOpen=false">关闭</button></div><label>实例名称<input v-model="newInstanceName" autofocus placeholder="例如：朋友生存服" /></label><label>Minecraft 版本<input v-model="newInstanceVersion" placeholder="1.21.4" /></label><div class="modal-actions"><button type="button" class="btn btn-ghost" @click="createOpen=false">取消</button><button class="btn btn-primary" :disabled="busy">{{ busy ? '创建中…' : '创建实例' }}</button></div></form></div>
    <div v-if="saveOpen" class="modal-mask" @pointerdown.self="saveOpen=false"><form class="modal-card" @submit.prevent="createSave"><div class="section-heading"><div><h2>创建云端存档</h2><p class="muted">存档属于当前选中的逻辑实例。</p></div><button type="button" class="btn btn-ghost" @click="saveOpen=false">关闭</button></div><label>存档名称<input v-model="newSaveName" autofocus placeholder="新存档" /></label><label>说明<textarea v-model="newSaveDescription" rows="3" placeholder="可选" /></label><div class="modal-actions"><button type="button" class="btn btn-ghost" @click="saveOpen=false">取消</button><button class="btn btn-primary" :disabled="busy">{{ busy ? '创建中…' : '创建存档' }}</button></div></form></div>
    <article v-if="status.signedIn && props.loginOnly" class="panel-card login-only-success">
      <div class="login-session-head">
        <span class="cloud-mark">NC</span>
        <div>
          <p class="eyebrow">NOMADCRAFT SESSION</p>
          <h2>NomadCraft 已登录</h2>
          <p class="muted">当前账号可以从侧边栏「云端」进入实例、存档、房间和权限管理。</p>
        </div>
        <span class="session-state"><i></i>连接正常</span>
      </div>
      <div class="login-session-meta">
        <div><small>登录账号</small><strong>{{ status.username || '当前会话' }}</strong></div>
        <div><small>服务地址</small><strong>{{ status.address }}</strong></div>
      </div>
      <div class="login-session-actions">
        <button class="btn btn-primary" @click="store.currentView = 'cloud'">打开云端中心</button>
        <button class="btn btn-danger-ghost" :disabled="busy" @click="logout">退出登录</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.nomad-page{max-width:1240px;margin:0 auto;padding:26px 30px 60px;color:var(--text)}
.nomad-heading,.section-heading,.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.nomad-heading{margin-bottom:24px}.heading-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.eyebrow{margin:0 0 6px;color:var(--accent-2);font-size:11px;letter-spacing:.16em}.nomad-heading h1{margin:0 0 8px;font-size:30px}.nomad-page h2{margin:0 0 7px;font-size:18px}.muted{color:var(--text-dim)}.status-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border:1px solid var(--border);border-radius:999px;color:var(--text-dim);white-space:nowrap}.status-pill i{width:7px;height:7px;border-radius:50%;background:var(--text-dim)}.status-pill.online{color:var(--ok);border-color:var(--ok-border)}.status-pill.online i{background:var(--ok)}.btn{cursor:pointer;border:0;border-radius:9px;padding:10px 14px;color:inherit;font:inherit}.btn-primary{background:var(--accent-grad);color:var(--on-accent);font-weight:700}.btn-ghost{border:1px solid var(--border);background:var(--card-2);color:var(--text)}.btn:disabled{cursor:wait;opacity:.5}.full{width:100%}.message{margin-bottom:14px;padding:10px 12px;border-radius:9px;font-size:13px}.message.error{background:var(--danger-soft);color:var(--danger)}.message.success{background:var(--ok-soft);color:var(--ok)}.panel-card{min-width:0;padding:20px;border:1px solid var(--border);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--surface-content) 88%,transparent);box-shadow:var(--shadow)}.connect-layout{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:18px}.connect-card label{display:grid;gap:7px;margin:15px 0;color:var(--text-dim);font-size:13px}.connect-card input,.catalog-tools input,.catalog-tools select{width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid var(--border);border-radius:9px;background:var(--card-2);color:var(--text);font:inherit}.button-row{display:flex;gap:9px}.separator{display:flex;align-items:center;gap:10px;margin:22px 0 4px;color:var(--text-dim);font-size:12px}.separator:before,.separator:after{content:'';height:1px;flex:1;background:var(--border)}.cloud-intro{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:360px}.cloud-mark,.instance-mark{display:inline-grid;place-items:center;width:38px;height:28px;border-radius:8px;background:var(--accent);color:var(--on-accent);font-size:11px;font-weight:900;letter-spacing:.04em}.cloud-intro .cloud-mark{width:54px;height:38px;margin-bottom:18px}.cloud-intro h2{font-size:24px}.cloud-intro p{max-width:560px;line-height:1.75}.intro-points{display:grid;gap:9px;margin:16px 0 24px;color:var(--accent-2);font-size:13px}.cloud-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}.stat-card{display:grid;gap:5px;padding:16px;border:1px solid var(--border);border-radius:14px;background:var(--surface-content)}.stat-card span,.stat-card small{color:var(--text-dim);font-size:12px}.stat-card strong{font-size:27px}.cloud-workspace{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);gap:18px;align-items:start}.instance-catalog{display:grid;gap:12px}.catalog-tools{display:grid;grid-template-columns:minmax(0,1fr) 116px;gap:8px}.logical-instance{display:grid;grid-template-columns:38px minmax(0,1fr) 16px;align-items:center;gap:11px;width:100%;padding:12px;border:1px solid transparent;border-radius:12px;background:var(--card-2);color:var(--text);text-align:left;cursor:pointer}.logical-instance:hover,.logical-instance.selected{border-color:var(--accent);background:var(--accent-soft)}.instance-mark{width:38px;height:38px;border-radius:11px}.instance-copy{display:grid;gap:3px;min-width:0}.instance-copy strong,.instance-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.instance-copy small{color:var(--text-dim);font-size:11px}.instance-arrow{color:var(--text-dim);font-size:20px}.detail-heading h2{font-size:24px}.detail-heading p{margin-bottom:0}.revision{padding:5px 8px;border-radius:7px;background:var(--card-2);color:var(--text-dim);font-size:11px;white-space:nowrap}.detail-tabs{display:flex;gap:4px;margin:20px -20px 0;padding:0 20px;border-bottom:1px solid var(--border)}.detail-tabs button{padding:10px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-dim);cursor:pointer;font:inherit}.detail-tabs button.active{border-color:var(--accent);color:var(--accent-2)}.detail-content{padding-top:20px}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.detail-grid>div{display:grid;gap:5px;padding:12px;border-radius:10px;background:var(--card-2)}.detail-grid small,.selected-save small,.permission-summary>small,.owner-line small{color:var(--text-dim);font-size:11px}.selected-save,.owner-line{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:11px;background:var(--card-2)}.selected-save>div,.owner-line>span:nth-child(2){display:grid;gap:4px;min-width:0}.selected-save .muted{font-size:12px}.permission-summary{display:grid;gap:9px;margin-top:18px}.permission-summary>div{display:flex;flex-wrap:wrap;gap:7px}.permission-pill{display:inline-flex;padding:4px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-2);font-size:11px}.permission-pill.strong{margin-left:auto}.save-list{display:grid;gap:9px}.save-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:12px;border:1px solid var(--border);border-radius:11px;background:var(--card-2);color:var(--text);text-align:left;cursor:pointer}.save-row:hover,.save-row.selected{border-color:var(--accent)}.save-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--accent-soft);color:var(--accent-2)}.save-row>span:nth-child(2){display:grid;gap:4px;min-width:0}.save-row small,.save-status small{display:block;color:var(--text-dim);font-size:11px}.save-status{color:var(--text-dim);font-size:12px;text-align:right}.save-status.online{color:var(--ok)}.permission-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:16px}.permission-card{display:grid;gap:4px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--card-2)}.permission-card small{color:var(--text-dim);font-size:10px}.permission-note{margin-top:16px;font-size:12px;line-height:1.7}.empty{padding:34px 14px;text-align:center;color:var(--text-dim)}.empty.compact{padding:22px 14px}.empty-detail{display:grid;place-items:center;min-height:360px;text-align:center}.empty-detail h2{margin-top:14px}.small{width:28px;height:24px;border-radius:7px;font-size:9px}@media(max-width:900px){.connect-layout,.cloud-workspace{grid-template-columns:1fr}.cloud-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.nomad-page{padding:20px 16px 48px}.nomad-heading{display:block}.heading-actions{margin-top:14px}.catalog-tools,.detail-grid{grid-template-columns:1fr 1fr}.permission-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.selected-save{align-items:stretch;flex-direction:column}.permission-pill.strong{margin-left:0}}
.login-only-success{display:grid;gap:18px;width:min(720px,100%);margin:34px auto;padding:24px 26px}.login-only-success h2,.login-only-success p{margin:0}.login-session-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:14px}.login-session-head>div{display:grid;gap:5px;min-width:0}.login-session-head .eyebrow{margin:0;color:var(--accent-2);font-size:10px;letter-spacing:.16em}.login-session-head h2{font-size:21px}.login-session-head .muted{line-height:1.65}.session-state{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--ok) 45%,var(--border));border-radius:999px;color:var(--ok);font-size:11px;white-space:nowrap}.session-state i{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}.login-session-meta{display:grid;grid-template-columns:minmax(0,.65fr) minmax(0,1.35fr);gap:10px}.login-session-meta>div{display:grid;gap:5px;min-width:0;padding:12px 13px;border:1px solid var(--border);border-radius:11px;background:var(--card-2)}.login-session-meta small{color:var(--text-dim);font-size:11px}.login-session-meta strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.login-session-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding-top:2px}.btn-danger-ghost{border:1px solid color-mix(in srgb,var(--danger) 50%,var(--border));background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}.btn-danger-ghost:hover{background:color-mix(in srgb,var(--danger) 15%,transparent)}.section-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.save-actions{justify-content:flex-end;margin-bottom:10px}.save-row{cursor:pointer}.save-row .btn{white-space:nowrap}.modal-mask{position:fixed;z-index:9000;inset:0;display:grid;place-items:center;padding:20px;background:var(--mask);backdrop-filter:blur(5px)}.modal-card{width:min(520px,calc(100vw - 32px));padding:22px;border:1px solid var(--border);border-radius:16px;background:var(--card-solid,var(--surface-content));box-shadow:var(--shadow-lg)}.modal-card label{display:grid;gap:7px;margin:16px 0;color:var(--text-dim);font-size:13px}.modal-card input,.modal-card textarea{box-sizing:border-box;width:100%;padding:10px 11px;border:1px solid var(--border);border-radius:9px;background:var(--card-2);color:var(--text);font:inherit;resize:vertical}.modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}.network-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.network-grid>div{display:grid;gap:5px;padding:14px;border-radius:10px;background:var(--card-2)}.network-grid small,.network-actions p{color:var(--text-dim);font-size:11px}.network-address{overflow-wrap:anywhere}.network-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)}.network-actions p{margin:0;line-height:1.7}@media(max-width:600px){.network-grid{grid-template-columns:1fr}.network-actions{align-items:flex-start;flex-direction:column}.login-only-success{margin:24px auto;padding:20px}.login-session-head{grid-template-columns:auto minmax(0,1fr)}.session-state{grid-column:2;justify-self:start}.login-session-meta{grid-template-columns:1fr}.login-session-actions{align-items:stretch;flex-direction:column}.login-session-actions .btn{width:100%}}.cloud-instance-sync{font-size:11px}.cloud-instance-sync.synced,.sync-state.synced{color:var(--ok)}.cloud-instance-sync.warning,.sync-state.warning{color:var(--warning,var(--accent-2))}.cloud-instance-sync.muted,.sync-state.muted{color:var(--text-dim)}.cloud-instance-sync.checking,.sync-state.checking{color:var(--accent-2)}.local-binding-card{display:grid;gap:12px;margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--card-2)}.local-binding-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.local-binding-card header>div{display:grid;gap:4px;min-width:0}.local-binding-card header small{color:var(--text-dim);font-size:11px}.local-binding-card header strong{font-size:15px}.local-binding-path{font-size:11px;overflow-wrap:anywhere}.sync-state{display:inline-flex;flex:none;padding:5px 8px;border:1px solid var(--border);border-radius:999px;font-size:11px}.local-binding-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.local-binding-actions select{min-width:0;flex:1;padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface-content);color:var(--text);font:inherit}.local-binding-note{margin:0;font-size:11px;line-height:1.6}@media(max-width:600px){.local-binding-card header{align-items:stretch;flex-direction:column}.local-binding-actions{align-items:stretch;flex-direction:column}.local-binding-actions select{width:100%}}
</style>