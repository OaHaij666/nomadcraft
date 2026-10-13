<script setup lang="ts">
import { prepareCloud, cloudPreparation, prepareKey } from "../cloudPreparation"
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  getInstalled,
  getSettings,
  copyText,
  errText,
} from "../api";
import { store, refreshCloudInstances, toast, displayVersionName } from "../store";
import SelectMenu from "./SelectMenu.vue";
import type { InstalledVersion } from "@shared/types";
import type { DistributionFile } from "../../../../../mcsmanager/shared/nomad-distribution";
const emit = defineEmits<{ (e: "close"): void }>();
const invoke = (name: string, ...args: unknown[]) =>
  window.kamucl.invoke("nomad:" + name, ...args.map(value=>value===undefined?undefined:JSON.parse(JSON.stringify(value)))) as Promise<any>;
const instances = ref<any[]>([]),
  clients = ref<InstalledVersion[]>([]),
  choice = ref(""),
  clientChoice = ref(""),
  info = ref<any>(),
  error = ref(""),
  busy = ref(""),
  view = ref<"sync" | "host" | "transfer">("sync");
const selectedPaths = ref<string[]>([]),
  accepted = ref<string[]>([]),
  runs = ref<any[]>([]),
  node = ref<any>(),
  javaPath = ref(""),
  nodeName = ref("我的电脑"),
  memory = ref(4096);
const acceptEula = ref(false);
const computeNodes=ref<any[]>([]),handoverTarget=ref("");
const handoverOptions=computed(()=>computeNodes.value.filter(n=>n.online&&n.enabled).map(n=>({value:n.id,label:n.name,description:(n.kind==="server"?"服务器":"玩家电脑")+" · 可用内存 "+(n.metrics?.availableMemoryMb??"未知")+" MiB"})));
const handoverLabels:Record<string,string>={saving:"正在保存并上传旧主机存档",restoring:"正在等待新主机恢复并启动",completed:"交接完成"};
const peers = ref<any[]>([]),
  jobs = ref<any[]>([]),
  peerId = ref(""),
  peerName = ref(""),
  peerOrigin = ref(""),
  peerServiceId = ref(""),
  privatePeer = ref(false),
  acceptToken = ref(""),
  invitation = ref(""),
  newName = ref(""),
  acceptance = ref<any>(),
  targetInstance = ref(""),
  releaseChoice = ref("");
const options = computed(() =>
  instances.value.flatMap((i) => [
    {
      value: JSON.stringify({ instanceId: i.id }),
      label: i.name + " · 实例环境",
      description: i.profile.mcVersion + " · " + i.profile.loader,
    },
    ...(i.saves ?? []).map((s: any) => ({
      value: JSON.stringify({ instanceId: i.id, saveId: s.id }),
      label: i.name + " / " + s.name,
      description: "存档固定发布版 · " + (runs.value.find(r => r.instanceId === i.id && r.saveId === s.id && ["starting", "running", "stopping"].includes(r.state))?.state ?? s.hosting?.phase ?? "未托管"),
    })),
  ]),
);
const reference = computed(() => {
  try {
    return JSON.parse(choice.value);
  } catch {
    return undefined;
  }
});
const preparation = computed(() => reference.value ? cloudPreparation[prepareKey(reference.value)] : undefined);
const instance = computed(() =>
  instances.value.find((i) => i.id === reference.value?.instanceId),
);
const save = computed(() =>
  instance.value?.saves.find((s: any) => s.id === reference.value?.saveId),
);
const canPublish = computed(
  () =>
    instance.value?.permissions?.includes("mods.manage") &&
    instance.value?.permissions?.includes("instance.update"),
);
const currentRun = computed(() =>
  runs.value.find(
    (r) =>
      r.instanceId === reference.value?.instanceId &&
      r.saveId === reference.value?.saveId &&
      ["starting", "running", "stopping"].includes(r.state),
  ),
);
const selectable = computed(() =>
  clients.value
    .filter((v) => !v.failed && !v.incomplete && v.isolated)
    .map((v) => ({
      value: JSON.stringify({ id: v.id, folder: v.folder }),
      label: displayVersionName(v),
      description: v.mcVersion + " · " + v.loader + " · " + v.folder,
    })),
);
const labels: Record<string, string> = {
  checking: "等待文件校验",
  synced: "已验证同步",
  unbound: "未绑定",
  conflict: "存在文件冲突",
  "local-ahead": "本地有改动",
  "cloud-ahead": "云端有新发布版",
};
let timer: ReturnType<typeof setInterval> | undefined,
  disposed = false;
async function work(name: string, action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = name;
  error.value = "";
  try {
    await action();
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = "";
  }
}
async function refresh() {
  const catalog = await invoke("catalog");
  instances.value = catalog.instances;
  clients.value = await getInstalled(true);
  if (!options.value.some((v) => v.value === choice.value))
    choice.value = options.value[0]?.value ?? "";
  await refreshCloudInstances();
  await poll();
}
async function inspect() {
  info.value = undefined;
  accepted.value = [];
  selectedPaths.value = [];
  if (!reference.value) return;
  try {
    info.value = await invoke("distribution:inspect", reference.value);
    const previous = info.value.baseline?.manifest.files ?? [];
    selectedPaths.value = info.value.local
      .filter(
        (f: any) =>
          f.path.startsWith("mods/") ||
          previous.some((p: any) => p.path === f.path),
      )
      .map((f: any) => f.path);
    error.value = "";
  } catch (e) {
    error.value = errText(e);
  }
}
watch(choice, () => {
  void inspect();
  releaseChoice.value = "";
  acceptance.value = undefined;
});
async function unbind(){await work("unbind",async()=>{await invoke("distribution:unbind",reference.value);store.settings=await getSettings();await refreshCloudInstances();await inspect();toast("已解除绑定，本地文件保留","info")})}
async function bind() {
  await work("bind", async () => {
    if (!clientChoice.value) throw new Error("请选择独立本地客户端");
    await invoke(
      "distribution:bind",
      reference.value,
      JSON.parse(clientChoice.value),
    );
    store.settings = await getSettings();
    await refreshCloudInstances();
    await inspect();
    toast("云端实例已绑定本地客户端", "success");
  });
}
async function publish() {
  await work("publish", async () => {
    const files: DistributionFile[] = info.value.local
      .filter((f: any) => selectedPaths.value.includes(f.path))
      .map((f: any) => ({ ...f, ownership: "managed" }));
    const release = await invoke(
      "distribution:publish",
      reference.value,
      files,
    );
    await refresh();
    await inspect();
    toast("新发布版已创建；存档固定版本需要单独切换", "success");
    releaseChoice.value = release.id;
  });
}
async function pull() {
  await work("pull", async () => {
    await invoke("distribution:pull", reference.value, accepted.value);
    store.settings = await getSettings();
    await refreshCloudInstances();
    await inspect();
    toast("文件校验及同步完成", "success");
  });
}
async function rollback() {
  await work("rollback", async () => {
    await invoke("distribution:rollback", reference.value);
    store.settings = await getSettings();
    await refreshCloudInstances();
    await inspect();
    toast("已恢复同步前的受管文件", "success");
  });
}
async function recover() {
  await work("recover", async () => {
    await invoke("distribution:recover", reference.value);
    await inspect();
  });
}
async function switchRelease() {
  await work("release", async () => {
    await invoke(
      "distribution:bindRelease",
      reference.value,
      releaseChoice.value,
    );
    await refresh();
    await inspect();
  });
}
async function prepareClient() {
  await work("prepare", async () => { if (await prepareCloud(reference.value)) { await refresh(); await inspect(); } });
}
async function join() {
  await work("join", async () => { if (await prepareCloud(reference.value, true)) { await refresh(); await inspect(); } });
}
async function host() {
  await work("host", async () => {
    await invoke("hosting:host", reference.value, javaPath.value || undefined);
    await poll();
  });
}
async function handover(){await work("handover",async()=>{if(!reference.value?.saveId||!handoverTarget.value)throw new Error("请选择存档和目标计算节点");await invoke("hosting:handover",reference.value,handoverTarget.value);toast("交接已开始：旧主机保存成功后，新主机才会接手。","success");await poll();});}
async function pair() {
  await work("pair", async () => {
    await invoke("hosting:pair", {
      name: nodeName.value,
      memoryBudgetMb: memory.value,
    });
    await poll();
  });
}
async function startNode() {
  await work("node", async () => {
    await invoke("hosting:node", javaPath.value || undefined);
    await poll();
  });
}
async function stop(id: string) {
  await work("stop", async () => {
    await invoke("hosting:stop", id);
    await poll();
  });
}
async function poll() {
  if (disposed) return;
  try {
    runs.value = await invoke("hosting:status");
    node.value = await invoke("hosting:nodeInfo");
    if(view.value==="host"&&reference.value?.instanceId){computeNodes.value=await invoke("hosting:nodes",reference.value.instanceId);const catalog=await invoke("catalog");instances.value=catalog.instances;}
    if (view.value === "transfer") {
      jobs.value = await invoke("distribution:jobs");
      try {
        peers.value = await invoke("distribution:peers");
      } catch {
        peers.value = [];
      }
    }
  } catch {}
}
async function copyInvitation() {
  const release = info.value?.release;
  if (!release?.manifestDigest) throw new Error("请先选择已发布文件清单的版本");
  await copyText(
    JSON.stringify({
      sourceServiceId: info.value.serviceId,
      sourceInstanceId: reference.value.instanceId,
      releaseId: release.id,
      digest: release.manifestDigest,
    }),
  );
  toast("已复制实例推送信息，在目标云端生成接收授权", "success");
}
async function accept() {
  await work("accept", async () => {
    const payload = {
      ...JSON.parse(invitation.value),
      acceptEula: acceptEula.value,
    };
    if (targetInstance.value) {
      const target = instances.value.find((i) => i.id === targetInstance.value);
      payload.targetInstanceId = target.id;
      payload.expected = {
        revision: target.revision,
        baseReleaseId: target.releases?.slice(-1)[0]?.id ?? null,
      };
    }
    acceptance.value = await invoke("distribution:accept", payload);
  });
}
async function revoke() {
  await work("revoke", async () => {
    await invoke("distribution:revoke", acceptance.value.id);
    acceptance.value = undefined;
  });
}
async function addPeer() {
  await work("peer", async () => {
    await invoke("distribution:peerAdd", {
      name: peerName.value,
      origin: peerOrigin.value,
      serviceId: peerServiceId.value,
      allowPrivate: privatePeer.value,
    });
    await poll();
  });
}
async function cancelPush(id:string){await work("cancel",async()=>{await invoke("distribution:cancelPush",id);await poll()})}
async function push() {
  await work("push", async () => {
    if (!info.value?.release) throw new Error("请选择已发布实例");
    await invoke("distribution:push", {
      instanceId: reference.value.instanceId,
      releaseId: info.value.release.id,
      peerId: peerId.value,
      acceptanceToken: acceptToken.value,
    });
    await poll();
  });
}
onMounted(() => {
  void work("load", refresh);
  timer = setInterval(() => void poll(), 1500);
});
onUnmounted(() => {
  disposed = true;
  if (timer) clearInterval(timer);
});
</script>
<template>
  <section class="cloud-operations">
    <header>
      <div>
        <button class="btn btn-ghost" @click="emit('close')">
          ← 返回实例中心
        </button>
        <h2>实例同步与托管</h2>
        <p>云端管理发布版，本地保存游戏文件；计算节点运行真实服务端。</p>
      </div>
      <button
        class="btn btn-ghost"
        :disabled="!!busy"
        @click="
          work('refresh', async () => {
            await refresh();
            await inspect();
          })
        "
      >
        刷新
      </button>
    </header>
    <div class="context">
      <label
        >云端实例 / 存档<SelectMenu
          v-model="choice"
          :options="options"
          placeholder="请选择云端实例" /></label
      ><span v-if="info" class="state">{{
        labels[info.state] || info.state
      }}</span>
    </div>
    <p v-if="preparation" :class="{ error: preparation.state === 'error' }" role="status">{{ preparation.message }}<template v-if="preparation.busy && preparation.progress !== undefined"> · {{ Math.round(preparation.progress * 100) }}%</template></p>
    <nav class="operation-tabs">
      <button :class="{ active: view === 'sync' }" @click="view = 'sync'">
        发布与本地同步</button
      ><button :class="{ active: view === 'host' }" @click="view = 'host'">
        本机托管与计算节点</button
      ><button
        :class="{ active: view === 'transfer' }"
        @click="
          view = 'transfer';
          poll();
        "
      >
        推送到其它云端
      </button>
    </nav>
    <div v-if="error" class="operation-error" role="alert">
      {{ error
      }}<button
        v-if="error.includes('恢复')"
        class="btn btn-ghost"
        :disabled="!!busy"
        @click="recover"
      >
        恢复未完成事务
      </button>
    </div>
    <p v-if="busy" class="muted" role="status">
      {{
        busy === "publish"
          ? "正在上传并发布，完成后才会生成新版本…"
          : busy === "pull"
            ? "正在下载、校验和应用文件…"
            : busy === "host"
              ? "正在准备执行器…"
              : "正在处理…"
      }}
    </p>
    <template v-if="view === 'sync'">
      <article>
        <h3>本地客户端目录</h3>
        <p class="muted">
          可自动安装与当前云端发布版匹配的客户端。也可以手动绑定已有的独立客户端。
        </p>
        <button class="btn btn-primary" :disabled="!!busy || !reference" @click="prepareClient">自动准备客户端</button>
        <div class="binding">
          <SelectMenu
            v-model="clientChoice"
            :options="selectable"
            placeholder="选择独立本地客户端"
          /><button
            class="btn btn-ghost"
            :disabled="!!busy || !reference || !clientChoice"
            @click="bind"
          >
            绑定
          </button>
        </div>
        <p v-if="info" class="path">{{ info.directory }}</p><button v-if="info" class="btn btn-ghost" :disabled="!!busy" @click="unbind">解除绑定（保留文件）</button>
        <p v-else class="muted">尚未绑定本地客户端，或当前目录需要恢复。</p>
      </article>
      <article v-if="save">
        <h3>存档固定发布版</h3>
        <p class="muted">
          发布新环境不会自动升级存档。关闭房间并停服后才能切换固定版本。
        </p>
        <div class="binding">
          <SelectMenu
            v-model="releaseChoice"
            :options="
              (instance?.releases ?? []).map((r: any) => ({
                value: r.id,
                label: r.id,
                description: r.id === save.releaseId ? '当前固定版本' : '',
              }))
            "
          /><button
            class="btn btn-ghost"
            :disabled="
              !!busy ||
              !releaseChoice ||
              !instance?.savePermissions?.[save.id]?.includes('save.update')
            "
            @click="switchRelease"
          >
            切换固定版本
          </button>
        </div>
      </article>
      <article v-if="info">
        <h3>同步云端发布版</h3>
        <p class="muted">
          {{ info.release?.id || "此实例尚无发布版" }} ·
          只更新清单管理的文件，额外材质、光影和未知文件保留。
        </p>
        <div v-if="info.diff.length" class="file-list">
          <label v-for="d in info.diff" :key="d.path"
            ><input
              v-if="d.conflict"
              v-model="accepted"
              type="checkbox"
              :value="d.path"
            /><span>{{ d.path }}</span
            ><small :class="{ warning: d.conflict }">{{
              d.conflict
                ? "冲突 · 确认备份后覆盖"
                : (
                    {
                      add: "新增",
                      change: "更新",
                      remove: "移除",
                      same: "一致",
                    } as any
                  )[d.operation]
            }}</small></label
          >
        </div>
        <div class="actions">
          <button
            class="btn btn-primary"
            :disabled="!!busy || !info.release?.manifest"
            @click="pull"
          >
            同步到本地</button
          ><button class="btn btn-ghost" :disabled="!!busy" @click="rollback">
            回滚上一次同步</button
          ><button
            class="btn btn-ghost"
            :disabled="!!busy"
            @click="work('inspect', inspect)"
          >
            重新校验
          </button>
        </div>
      </article>
      <article v-if="info">
        <h3>发布本地改动</h3>
        <p class="muted">
          MOD
          默认选中。配置、脚本或必需资源请逐项选择；选择后由云端管理。不要选择个人数据或运行时数据库。未选中的旧受管文件会从新清单移除。
        </p>
        <p v-if="!canPublish" class="warning">
          发布需要此实例的 MOD 管理和实例编辑权限。
        </p>
        <div class="file-list">
          <label v-for="f in info.local" :key="f.path"
            ><input
              v-model="selectedPaths"
              type="checkbox"
              :value="f.path"
              :disabled="!!busy || !canPublish"
            /><span>{{ f.path }}</span
            ><small>{{ (f.size / 1024).toFixed(1) }} KiB</small></label
          >
        </div>
        <button
          class="btn btn-primary"
          :disabled="!!busy || !canPublish"
          @click="publish"
        >
          校验并发布新版本
        </button>
      </article>
    </template>
    <template v-if="view === 'host'">
      <article>
        <h3>由本机托管房间</h3>
        <p class="muted">
          支持原版、Fabric、Forge、NeoForge 和 Paper 服务端。房间须已开放且你拥有托管资格；停止时会正常保存并回传存档。
        </p>
        <label
          >Java 可执行文件（留空自动选择）<input
            v-model="javaPath"
            placeholder="例如 C:\Java\bin\java.exe"
            :disabled="!!busy"
        /></label>
        <div class="actions">
          <button
            class="btn btn-primary"
            :disabled="!!busy || !save"
            @click="join"
          >
            准备客户端并加入房间</button
          ><button
            class="btn btn-primary"
            :disabled="!!busy || !save?.hostingAllowed || !!currentRun"
            @click="host"
          >
            本机托管此存档</button
          ><button
            v-if="currentRun"
            class="btn btn-ghost"
            :disabled="!!busy || currentRun.state === 'stopping'"
            @click="stop(currentRun.id)"
          >
            停服并回传存档
          </button>
        </div>
        <p v-if="!save" class="muted">请选择具体存档后托管。</p>
      </article>
      <article v-if="save && instance?.permissions?.includes('room.manage')">
        <h3>交接计算主机</h3>
        <p class="muted">选择已在线的计算节点接手。交接会等待最终存档提交，避免新旧主机产生两个不同的世界。</p>
        <label>接手的计算节点<SelectMenu v-model="handoverTarget" :options="handoverOptions" placeholder="请选择在线节点" :disabled="!!busy" /></label>
        <div class="actions"><button class="btn btn-primary" :disabled="!!busy||!handoverTarget||save.hosting?.phase!=='ready'||(save.hosting?.handover&&save.hosting.handover.phase!=='completed')" @click="handover">开始交接</button></div>
        <p v-if="save.hosting?.handover" class="muted">{{handoverLabels[save.hosting.handover.phase]??save.hosting.handover.phase}}</p>
      </article>
      <article>
        <h3>作为常驻玩家计算节点</h3>
        <p class="muted">
          配对凭据由系统安全存储加密。开启后参与中心调度；关闭会正常结束本机任务并回传存档。
        </p>
        <div v-if="!node" class="node-form">
          <label>节点名称<input v-model="nodeName" /></label
          ><label
            >任务内存预算（MiB）<input
              v-model.number="memory"
              type="number"
              min="512"
              max="1048576" /></label
          ><button class="btn btn-primary" :disabled="!!busy" @click="pair">
            配对此电脑
          </button>
        </div>
        <template v-else
          ><p>
            {{ node.node.name }} ·
            {{ node.accountMatches ? "当前账号" : "属于其它账号" }}
          </p>
          <button
            class="btn btn-primary"
            :disabled="
              !!busy ||
              !node.accountMatches ||
              runs.some(
                (r) =>
                  r.kind === 'node' &&
                  ['starting', 'running', 'stopping'].includes(r.state),
              )
            "
            @click="startNode"
          >
            启动计算节点
          </button></template
        >
      </article>
      <article v-for="r in runs" :key="r.id">
        <div class="run-heading">
          <h3>
            {{ r.kind === "node" ? "计算节点" : "房间托管" }} · {{ r.state }}
          </h3>
          <button
            v-if="['starting', 'running'].includes(r.state)"
            class="btn btn-ghost"
            :disabled="!!busy"
            @click="stop(r.id)"
          >
            正常停止
          </button>
        </div>
        <p v-if="r.joinAddress">加入地址：{{ r.joinAddress }}</p>
        <p v-if="r.error" class="warning">{{ r.error }}</p>
        <pre class="logs">{{ r.logs.join("") }}</pre>
      </article>
    </template>
    <template v-if="view === 'transfer'">
      <article>
        <h3>从此云端推送实例</h3>
        <p class="muted">
          复制已发布环境，目标云端独立授权接收。默认不包含存档、成员权限、OP
          和计算节点。
        </p>
        <button
          class="btn btn-ghost"
          :disabled="!!busy || !info?.release?.manifestDigest"
          @click="work('invitation', copyInvitation)"
        >
          复制当前发布版的推送信息</button
        ><label
          >目标云端<SelectMenu
            v-model="peerId"
            :options="
              peers.map((p) => ({
                value: p.id,
                label: p.name,
                description: p.origin,
              }))
            " /></label
        ><label
          >目标方的一次性接收授权<input
            v-model="acceptToken"
            type="password"
            autocomplete="off"
            placeholder="在目标云端生成后粘贴" /></label
        ><button
          class="btn btn-primary"
          :disabled="!!busy || !peerId || !acceptToken || !canPublish"
          @click="push"
        >
          推送 / 继续传输
        </button>
      </article>
      <article>
        <h3>在此云端接收实例</h3>
        <p class="muted">
          在来源云端复制推送信息后粘贴。接收授权只适用于那一个发布版，目标实例由当前账号创建或显式更新。
        </p>
        <label
          >来源发布版信息<textarea
            v-model="invitation"
            rows="3"
            placeholder="粘贴来源云端复制的 JSON"
          ></textarea></label
        ><label
          >目标<SelectMenu
            v-model="targetInstance"
            :options="[
              { value: '', label: '创建独立新实例' },
              ...instances
                .filter(
                  (i) =>
                    i.permissions?.includes('mods.manage') &&
                    i.permissions?.includes('instance.update'),
                )
                .map((i) => ({ value: i.id, label: '更新 ' + i.name })),
            ]" /></label
        ><label class="checkbox"
          ><input v-model="acceptEula" type="checkbox" />我已阅读并接受
          Minecraft EULA，允许目标云端准备来源服务端运行环境</label
        ><button
          class="btn btn-primary"
          :disabled="!!busy || !invitation"
          @click="accept"
        >
          生成接收授权
        </button>
        <div v-if="acceptance" class="acceptance">
          <p>本云端身份：{{ acceptance.destinationServiceId }}</p>
          <p>有效期至：{{ new Date(acceptance.expiresAt).toLocaleString() }}</p>
          <button
            class="btn btn-ghost"
            @click="
              copyText(acceptance.token);
              toast('已复制接收授权', 'success');
            "
          >
            复制接收授权</button
          ><button class="btn btn-ghost" :disabled="!!busy" @click="revoke">
            撤销授权
          </button>
        </div>
      </article>
      <details>
        <summary>管理员：登记目标云端</summary>
        <article>
          <label>名称<input v-model="peerName" /></label
          ><label
            >服务根地址<input
              v-model="peerOrigin"
              placeholder="https://nomad.example.com" /></label
          ><label
            >目标服务身份<input
              v-model="peerServiceId"
              placeholder="目标方接收授权界面提供的身份" /></label
          ><label class="checkbox"
            ><input
              v-model="privatePeer"
              type="checkbox"
            />显式允许该目标使用内网地址（本机调试 HTTP 也需要勾选）</label
          ><button
            class="btn btn-ghost"
            :disabled="!!busy || !peerOrigin || !peerServiceId"
            @click="addPeer"
          >
            验证身份并登记
          </button>
        </article>
      </details>
      <article v-if="jobs.length">
        <h3>传输记录</h3>
        <div v-for="j in jobs" :key="j.id" class="job">
          <strong>{{ j.state }}</strong><button v-if="['pending','uploading','interrupted'].includes(j.state)" class="btn btn-ghost" :disabled="!!busy" @click="cancelPush(j.id)">取消传输</button><span>{{ j.releaseId }}</span
          ><small>{{ (j.bytes / 1024 / 1024).toFixed(1) }} MiB</small>
          <p v-if="j.error" class="warning">{{ j.error }}</p>
          <p v-if="j.result">
            目标实例：{{ j.result.instanceId }} · 目标发布版：{{
              j.result.releaseId
            }}
          </p>
        </div>
      </article>
    </template>
  </section>
</template>
<style scoped>
.cloud-operations {
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
  box-sizing: border-box;
  overflow: auto;
  width: 100%;
  height: 100%;
  color: var(--text);
}
header,
.run-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 22px;
}
h3 {
  margin: 0 0 12px;
  font-size: 15px;
}
p {
  font-size: 12px;
  line-height: 1.8;
}
header p,
.muted {
  color: var(--text-dim);
}
article {
  padding: 20px;
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card-2);
}
.context {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 20px 0;
}
.context label {
  flex: 1;
}
.state {
  padding: 8px 12px;
  border-radius: 20px;
  background: var(--accent-soft);
  font-size: 12px;
}
.operation-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}
.operation-tabs button {
  padding: 12px 15px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.operation-tabs button.active {
  border-color: var(--accent);
  color: var(--accent-2);
}
label {
  display: grid;
  gap: 8px;
  margin: 12px 0;
  font-size: 12px;
  color: var(--text-dim);
}
input:not([type="checkbox"]),
textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-content);
  color: var(--text);
  padding: 10px 12px;
  font: inherit;
}
textarea {
  resize: vertical;
}
.binding,
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.binding > *:first-child {
  flex: 1;
  min-width: 200px;
}
.btn {
  padding: 10px 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary {
  background: var(--accent-grad);
  color: var(--on-accent);
}
.btn-ghost {
  background: var(--surface-content);
  color: var(--text);
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.path {
  overflow-wrap: anywhere;
}
.file-list {
  max-height: 290px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
  margin: 16px 0;
}
.file-list label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.file-list label:last-child {
  border-bottom: 0;
}
.file-list span {
  flex: 1;
  overflow-wrap: anywhere;
  color: var(--text);
}
small {
  font-size: 11px;
  color: var(--text-dim);
}
.warning,
.operation-error {
  color: var(--danger);
}
.operation-error {
  background: var(--card);
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.logs {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  font: 11px/1.7 monospace;
  background: var(--surface-content);
  padding: 12px;
  border-radius: 8px;
}
.node-form {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: end;
  gap: 14px;
}
.node-form label {
  margin: 0;
}
.checkbox {
  display: flex;
  align-items: center;
}
.job {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.job p {
  width: 100%;
  margin: 0;
}
summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
}
@media (max-width: 750px) {
  .cloud-operations {
    padding: 16px;
  }
  .context,
  .node-form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .operation-tabs {
    flex-wrap: wrap;
  }
  .file-list small {
    max-width: 90px;
  }
}
</style>
