<script setup lang="ts">
import YsmViewer3D from "./YsmViewer3D.vue";
import { reactive, ref, onMounted, onUnmounted, watch } from "vue";
import { ysmApi } from "../ysmApi";
import { errText } from "../api";
import type { BotView } from "../../../../../mcsmanager/shared/nomad-bots";
import type { YsmAsset } from "@shared/ysm";
const previewAsset = ref("");
const hostState = ref<{ ready?: boolean; error?: string }>({});
const instanceState = ref<{ enabled: boolean }>({ enabled: false });
const scope = ref<"private" | "shared">("private");
const skinPlayer = ref("");
async function selectedSkin() {
  return skinPlayer.value.trim() ? await call("cloudBotSkin", skinPlayer.value.trim()) : undefined;
}
async function changeSkin(b: BotView) {
  await call("cloudBotAppearance", b.id, { revision: b.revision, skin: await selectedSkin() });
  notice.value = "外观更改已提交重新审核；批准前不会分发或换肤。";
  await refresh();
}
const publicModel = reactive({
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  persona: "",
  apiKey: "",
  maxTokens: 4096,
  maxTurns: 20,
  clearApiKey: false,
});
let runtimeTimer: ReturnType<typeof setInterval> | undefined;
const selectedBot = ref(""),
  runtime = ref<any>(),
  linkCommand = ref(""),
  editingBot = ref("");
function editPublic(b: BotView) {
  editingBot.value = b.id;
  scope.value = "shared";
  name.value = b.name;
  Object.assign(publicModel, b.model ?? {}, { apiKey: "", clearApiKey: false });
}
async function linkGame() {
  const link = await call("cloudBotLink");
  linkCommand.value = "/nomad-bot-link " + link.code;
  notice.value = "在游戏中执行下面的一次性命令，验证你当前的游戏身份。命令五分钟后失效。";
}
async function showRuntime(id: string) {
  selectedBot.value = id;
  runtime.value = await call("cloudBotRuntime", id);
}
async function body(b: BotView, action: string) {
  await call("cloudBotBody", b.id, action);
  notice.value =
    action === "join"
      ? "已加入游戏；私有机器人请到控制台启动自己的大脑。"
      : "已离开游戏，玩家数据和背包保留。";
  await refresh();
}
async function savePublic(b: BotView) {
  await call("cloudBotModel", b.id, {
    ...publicModel,
    apiKey: publicModel.apiKey || undefined,
    revision: b.revision,
  });
  publicModel.apiKey = "";
  notice.value = "服务器 AI 配置已保存，密钥不会再次显示。";
  editingBot.value = "";
  await refresh();
}
const props = defineProps<{
  scopeKey: string;
  companionName?: string;
  canReview: boolean;
  canReviewModels: boolean;
  canCreateShared: boolean;
}>();
const members = ref<Array<{ id: string; name: string }>>([]);
const bots = ref<BotView[]>([]),
  models = ref<any[]>([]),
  assets = ref<YsmAsset[]>([]),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const name = ref("NomadBot"),
  users = ref(""),
  message = ref(""),
  asset = ref(""),
  resource = ref(""),
  reason = ref("");
const call = (method: string, ...args: unknown[]) =>
  window.kamucl.invoke("numen:" + method, ...args) as Promise<any>;
const apiErrors: Record<string, string> = {
  bot_admission_required: "机器人尚未通过接入审核",
  bot_review_forbidden: "你没有审核机器人接入的权限",
  bot_control_forbidden: "你没有此实例的访问权限",
  bot_adapter_required: "游戏主机尚未连接 Numen 适配 MOD",
  bot_host_offline: "房间计算主机尚未上线",
  bot_instance_disabled: "请先启用此实例的 AI 陪玩",
  public_bot_api_key_required: "请配置此公有机器人的 API 密钥",
  bot_management_forbidden: "只有所有者可以修改私有机器人的名单",
  bot_resources_review_required: "请先审核批准机器人关联的模型资源",
  bot_already_registered: "此名字或游戏机器人已经有接入申请",
  bot_revision_conflict: "名单已被更新，请刷新后重试",
  invalid_bot_review: "申请状态已变化，请刷新后重试",
  model_review_forbidden: "你没有审核模型上传的权限",
  model_review_conflict: "上传申请状态已变化，请刷新后重试",
  model_blob_mismatch: "模型文件校验失败，请重新上传",
  model_upload_incomplete: "模型文件尚未上传完整",
  invalid_ysm_resources: "模型包含不支持的资源类型或超过大小限制",
  approved_model_path_conflict: "已批准模型中存在同名但内容不同的文件",
  server_bot_runtime_unavailable: "服务器机器人驱动接口尚未接入",
  bot_owner_runner_required: "只有机器人所有者的客户端可以领取运行任务",
  model_application_limit: "待处理模型申请过多，请先处理已有申请",
};
const friendlyError = (error: unknown) => {
  const raw = errText(error);
  return Object.entries(apiErrors).find(([code]) => raw.includes(code))?.[1] ?? raw;
};
const ids = (value: string) => value.split(/[\s,，]+/).filter(Boolean);
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  [bots.value, models.value, assets.value, members.value, hostState.value, instanceState.value] =
    await Promise.all([
      call("cloudBots"),
      call("cloudModels"),
      ysmApi.list(),
      call("cloudBotMembers"),
      call("cloudBotRoster"),
      call("cloudBotSettings"),
    ]);
}
async function register() {
  await call("cloudBotRegister", {
    scope: scope.value,
    skin: await selectedSkin(),
    ...(scope.value === "shared" ? { model: { ...publicModel } } : {}),
    name: name.value,
    access: { mode: "whitelist", users: ids(users.value) },
    resourceApplications: resource.value ? [resource.value] : [],
  });
  publicModel.apiKey = "";
  notice.value = "接入申请已提交，审核批准后才能召唤机器人。";
  await refresh();
}
async function upload() {
  const a = await call("cloudModelUpload", asset.value);
  resource.value = a.id;
  notice.value = "模型已上传到暂存区，等待审核。";
  await refresh();
}
async function reviewBot(b: BotView, decision: string) {
  await call("cloudBotReview", b.id, {
    revision: b.revision,
    decision,
    reason: reason.value,
  });
  await refresh();
}
async function reviewModel(a: any, decision: string) {
  await call("cloudModelReview", a.id, {
    revision: a.revision,
    decision,
    reason: reason.value,
  });
  await refresh();
}
async function command(b: BotView, action: string) {
  await call("cloudBotCommand", b.id, {
    action,
    ...(action === "message" ? { text: message.value } : {}),
  });
  notice.value =
    b.scope === "shared"
      ? "任务已交给服务器大脑；查看日志确认执行情况。"
      : "任务已排队，等待所有者客户端接收；排队不代表游戏任务已完成。";
}
const stateText = (s: string) =>
  ({
    pending: "待审核",
    approved: "已批准",
    rejected: "已拒绝",
    uploading: "上传未完成",
  })[s] || s;
onMounted(() => {
  void run(refresh);
  runtimeTimer = setInterval(() => {
    if (selectedBot.value && !busy.value)
      void call("cloudBotRuntime", selectedBot.value)
        .then((value) => {
          runtime.value = value;
        })
        .catch(() => {});
  }, 2000);
});
onUnmounted(() => {
  if (runtimeTimer) clearInterval(runtimeTimer);
  publicModel.apiKey = "";
});
watch(
  () => props.scopeKey,
  () => run(refresh),
);
</script>
<template>
  <section class="cloud-bots">
    <header>
      <div>
        <h2>云端机器人与模型审核</h2>
        <p>
          私有机器人由所有者的电脑运行，公有机器人由服务器运行。成员可向指定机器人发送 AI
          任务；游戏命令使用玩家身份与原生权限。
        </p>
      </div>
      <button :disabled="busy" @click="run(refresh)">刷新</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p class="host-status" role="status">
      {{
        !instanceState.enabled
          ? "此实例尚未启用 AI 陪玩，请在上方启用。"
          : hostState.ready
          ? "房间适配已连接，可以按审核结果加入机器人。"
          : hostState.error === "bot_adapter_required"
          ? "计算主机已连接，Numen 适配尚未就绪；启用后重启房间以安装适配。"
          : "计算主机尚未连接；房间启动后会检查 Numen 和适配 MOD。"
      }}
    </p>
    <article class="identity-link">
      <h3>游戏身份验证</h3>
      <p>
        私有机器人加入前，先在当前房间验证自己的游戏身份。服务器按审核后的归属召唤，不赋予玩家管理员权限。
      </p>
      <button :disabled="busy" @click="run(linkGame)">生成游戏内验证命令</button
      ><code v-if="linkCommand">{{ linkCommand }}</code>
    </article>
    <div class="forms">
      <article>
        <h3>申请接入机器人</h3>
        <label
          >运行归属<select v-model="scope">
            <option value="private">私有 · 我的客户端运行</option>
            <option v-if="canCreateShared" value="shared">公有 · 服务器运行</option>
          </select></label
        >
        <label>游戏内名字<input v-model="name" maxlength="16" placeholder="NomadBot" /></label>
        <p class="muted">游戏指令遵循玩家原生权限；成员可发送 AI 任务。</p>
        <label
          >关联模型申请<select v-model="resource">
            <option value="">不附带 YSM 模型</option>
            <option v-for="a in models" :key="a.id" :value="a.id">
              {{ a.name }} · {{ stateText(a.status) }}
            </option>
          </select></label
        >
        <label
          >原版皮肤来源玩家<input
            v-model="skinPlayer"
            maxlength="16"
            placeholder="留空使用默认皮肤；填写正版玩家名"
          /><small>Numen 使用 Mojang 签名皮肤，外观与接入申请一起审核。</small></label
        >
        <div v-if="scope === 'shared'" class="public-model">
          <h3>服务器 AI 配置</h3>
          <label
            >协议<select v-model="publicModel.protocol">
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select></label
          ><label>API 地址<input v-model="publicModel.baseUrl" /></label
          ><label>模型名称<input v-model="publicModel.model" /></label
          ><label
            >API 密钥<input
              v-model="publicModel.apiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="editingBot ? '输入新密钥以替换，留空保留' : '创建后不再回显'" /></label
          ><label v-if="editingBot"
            ><input v-model="publicModel.clearApiKey" type="checkbox" />清除已保存密钥</label
          ><label
            >角色人设<textarea v-model="publicModel.persona" maxlength="12000" rows="4" /></label
          ><small>服务器独立保存配置与对话；API 密钥不会回显或交给游戏主机。</small>
        </div>
        <button
          :disabled="busy || !name"
          @click="
            run(async () => {
              const bot = bots.find((b) => b.id === editingBot);
              if (bot) await savePublic(bot);
              else await register();
            })
          "
        >
          {{ editingBot ? "保存服务器 AI 配置" : "提交接入申请" }}</button
        ><button
          v-if="editingBot"
          :disabled="busy"
          @click="
            editingBot = '';
            publicModel.apiKey = '';
          "
        >
          取消修改
        </button>
      </article>
      <article>
        <h3>申请上传 YSM 模型</h3>
        <p>
          先从本地模型库选择。批准后自动部署到房间计算主机，发送 YSM
          热重载请求；玩家准备客户端时下载已批准资源。
        </p>
        <label
          >本地模型<select v-model="asset">
            <option value="">选择模型</option>
            <option v-for="a in assets" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select></label
        ><button
          :disabled="busy"
          @click="
            run(async () => {
              const a = await ysmApi.import();
              if (a) {
                asset = a.id;
                await refresh();
              }
            })
          "
        >
          导入 .ysm / ZIP</button
        ><button :disabled="busy || !asset" @click="run(upload)">上传并申请审核</button>
      </article>
    </div>
    <article>
      <h3>房间机器人</h3>
      <label
        >发给指定机器人的 AI 任务<input
          v-model="message"
          maxlength="16000"
          placeholder="不会广播给其他机器人"
      /></label>

      <p v-if="!bots.length" class="muted">还没有接入申请。</p>
      <div v-for="b in bots" :key="b.id" class="row">
        <div>
          <strong>{{ b.name }}</strong
          ><small
            >{{ b.ownerName }} ·
            {{ b.scope === "private" ? "私有 / 所有者运行" : "公有 / 服务器运行" }}
            · {{ stateText(b.admission) }}</small
          ><small v-if="b.scope === 'shared'"
            >{{ b.hasApiKey ? "API 密钥已保存，无法回显" : "尚未配置 API 密钥" }} ·
            {{ b.runtime === "server-ready" ? "主机适配已连接" : "等待主机适配连接" }}</small
          ><small v-if="b.reviewReason">审核说明：{{ b.reviewReason }}</small>
        </div>
        <div class="actions">
          <button v-if="b.canManage" :disabled="busy" @click="run(() => changeSkin(b))">
            申请更改皮肤</button
          ><button
            v-if="b.scope === 'shared' || b.canManage"
            :disabled="busy || b.admission !== 'approved'"
            @click="run(() => body(b, 'join'))"
          >
            加入游戏</button
          ><button
            v-if="b.scope === 'shared' || b.canManage"
            :disabled="busy || b.admission !== 'approved'"
            @click="run(() => body(b, 'leave'))"
          >
            退出游戏</button
          ><button
            v-if="b.scope === 'shared'"
            :disabled="busy"
            @click="run(() => showRuntime(b.id))"
          >
            运行日志</button
          ><button
            v-if="b.scope === 'shared' && b.canManage"
            :disabled="busy"
            @click="editPublic(b)"
          >
            修改服务器 AI 配置
          </button>
          <button
            :disabled="busy || !b.canControl || !message"
            @click="run(() => command(b, 'message'))"
          >
            发送 AI 任务</button
          ><button
            :disabled="busy || !b.canControl"
            @click="run(() => command(b, 'stop-thinking'))"
          >
            停止思考</button
          ><button
            v-if="b.canManage && b.admission === 'approved'"
            :disabled="busy"
            @click="
              run(async () => {
                const result = await call('cloudBotDelete', b.id);
                if (!result.cancelled) notice = '永久删除指令已提交，等待对应大脑执行。';
              })
            "
          >
            永久删除…</button
          ><template v-if="canReview && b.admission === 'pending'"
            ><button :disabled="busy" @click="run(() => reviewBot(b, 'approve'))">批准接入</button
            ><button :disabled="busy" @click="run(() => reviewBot(b, 'reject'))">
              拒绝
            </button></template
          >
        </div>
      </div>
    </article>
    <article v-if="runtime">
      <h3>服务器机器人日志</h3>
      <p>
        状态：{{ runtime.phase }} ·
        {{ runtime.host ? "游戏主机在线" : "游戏主机或适配 MOD 未连接" }}
      </p>
      <div class="runtime-logs">
        <pre v-for="(line, i) in runtime.logs" :key="i"
          >{{ new Date(line.time).toLocaleTimeString() }} {{ line.text }}</pre
        >
      </div>
      <button :disabled="busy" @click="run(() => showRuntime(selectedBot))">刷新日志</button>
    </article>
    <article>
      <h3>模型上传申请</h3>
      <div v-if="previewAsset" class="model-review-preview">
        <YsmViewer3D :asset-id="previewAsset" compact />
      </div>
      <label v-if="canReview || canReviewModels"
        >审核说明<input v-model="reason" maxlength="1000" placeholder="批准或拒绝的说明"
      /></label>
      <p v-if="!models.length" class="muted">还没有上传申请。</p>
      <div v-for="a in models" :key="a.id" class="row">
        <div>
          <strong>{{ a.name }}</strong
          ><small
            >{{ a.ownerName }} · {{ stateText(a.status) }} ·
            {{ a.manifest.files.length }} 个文件</small
          ><small>{{
            a.deployment?.state === "reload-requested"
              ? "已部署并发送热重载请求（尚未验证游戏加载结果）"
              : a.deployment?.state === "failed"
              ? "部署失败，请检查房间日志"
              : a.status === "approved"
              ? "已批准，等待房间主机部署"
              : ""
          }}</small
          ><small v-if="a.reason">审核说明：{{ a.reason }}</small>
        </div>
        <div class="actions">
          <button
            :disabled="busy"
            @click="
              run(async () => {
                const model = await call('cloudModelPreview', a.id);
                previewAsset = model.id;
              })
            "
          >
            查看模型预览</button
          ><template v-if="a.canReview && a.status === 'pending'">
            <button :disabled="busy" @click="run(() => reviewModel(a, 'approve'))">批准上传</button
            ><button :disabled="busy" @click="run(() => reviewModel(a, 'reject'))">拒绝</button>
          </template>
        </div>
      </div>
    </article>
    <p class="muted">
      公有大脑由服务器运行。陪玩支持 1.20.1 Fabric／Forge、1.21.1 Fabric／NeoForge，使用 Numen 0.1.4.1。
      安装并启用后，云端与本地使用同一发布版。密钥不会分发给玩家或计算主机。
    </p>
  </section>
</template>
<style scoped>
.model-review-preview {
  height: 320px;
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.runtime-logs {
  max-height: 320px;
  overflow: auto;
}
.runtime-logs pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}
.identity-link code {
  display: block;
  margin-top: 12px;
  overflow-wrap: anywhere;
}
.public-model {
  display: grid;
  gap: 12px;
  margin: 14px 0;
}
.cloud-bots {
  display: grid;
  gap: 14px;
  padding-bottom: 24px;
}
.cloud-bots header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.cloud-bots h2 {
  font-size: 18px;
  margin: 0;
}
.cloud-bots h3 {
  font-size: 14px;
  margin: 0 0 12px;
}
.cloud-bots p {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}
.cloud-bots article {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
}
.cloud-bots .forms {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  gap: 14px;
}
.cloud-bots label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 12px;
}
.cloud-bots input,
.cloud-bots textarea,
.cloud-bots select {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  background: var(--card-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px;
  font: inherit;
}
.cloud-bots button {
  background: var(--accent-soft);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.cloud-bots button:disabled {
  opacity: 0.45;
  cursor: default;
}
.cloud-bots .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.cloud-bots .row > div:first-child {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.cloud-bots small {
  font-size: 11px;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.cloud-bots .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  justify-content: flex-end;
}
.cloud-bots .error {
  color: var(--danger);
}
.cloud-bots :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 850px) {
  .cloud-bots .forms {
    grid-template-columns: 1fr;
  }
  .cloud-bots .row {
    align-items: flex-start;
    flex-direction: column;
  }
  .cloud-bots .actions {
    justify-content: flex-start;
  }
}
</style>
