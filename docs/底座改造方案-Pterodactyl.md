# 底座改造方案：用 Pterodactyl 当"皮"，换掉我们的"核"

> 需求：找一个成熟、开源、优质、**带完整前台 + 后端**的 MC 服务器仓库；
> 保留它的皮和边缘血肉，改造它最内核的地方，让**所有外在功能看起来都正常**。

---

## 一、结论：选 `pterodactyl/panel` + `pterodactyl/wings`

**理由只有一条，但是决定性的：** 它的架构天生就是"前台"和"后端"分成两个独立程序、
靠一套 REST API 通信。我们要换的"在哪儿跑服务端"这件最内核的事，
**恰好就落在那道缝上**。

| 项目 | Star | 语言 | 许可证 | 活跃 | 角色 |
| --- | --- | --- | --- | --- | --- |
| pterodactyl/panel | 9,292 | PHP + React | **MIT** | 2026-10-08 | 前台（Web UI + API） |
| pterodactyl/wings | 1,056 | Go | **MIT** | 2026-10-07 | 后端 daemon（每个节点） |

> 许可证我特意核过仓库里的 `LICENSE` 原文：**Panel 是 MIT**（GitHub 的 API 显示 NOASSERTION 是因为
> 文件带了商标补充说明，不是限制性许可）。MIT + MIT = 可以放心改、放心闭源。

### 为什么不是别的

| 候选 | 否决理由 |
| --- | --- |
| **pelican-dev/panel** | 是 Pterodactyl 的 fork，但改成 **AGPL-3.0**，传染性强，排除 |
| **MCSManager** | 架构是"中心面板 + 各节点 daemon"，但节点 daemon 是 JS 且耦合较紧，改造成本比 Wings 高 |
| **PufferPanel** | Apache-2.0 也不错，但生态和成熟度不如 Pterodactyl，UI/权限/API 完成度低一些 |
| **Crafty** | 仓库已迁移/改名，当前不可直接访问，且是单体架构 |

---

## 二、拆解：哪一层是"皮"，哪一层是"核"

### 现状（Pterodactyl 本来长这样）

```text
  浏览器
    |  HTTPS
    v
+-------------------+
|  Panel (前台)      |  PHP+Laravel+React
|  - 登录/注册/权限   |
|  - 服务器列表/控制台 |
|  - 文件管理/数据库  |
|  - 备份/计划任务    |
|  - Client API      |
+---------+---------+
          |  REST + Bearer token（节点密钥）
          v
+-------------------+
|  Wings (后端)      |  Go daemon，跑在每台机器
|  - 收 Panel 指令    |
|  - 用 Docker 开服   |
|  - SFTP / 控制台 WS |
|  - 备份 / 文件 API  |
+---------+---------+
          |
          v
      Docker 容器里跑 Paper/Fabric
```

### 改造后（我们的形态）

```text
  浏览器                      <-- 完全不动
    |
    v
+-------------------+
|  Panel (前台)      |  <-- 完全保留！这就是"皮"
|  所有页面/权限/API  |
+---------+---------+
          |  REST + Bearer token  <-- 契约不变，我们实现它
          v
+--------------------------------------------+
|  Nomad Wings（我们的后端）  <-- 换掉的是这里 |
|  对外：长得和 Wings 一模一样（API 兼容）        |
|  对内：不跑 Docker，而是：                     |
|    - 向 Coordinator 申请租约                  |
|    - 世界从快照恢复/上传                       |
|    - 在"当前主机玩家"的机器上开服               |
|    - 通过 relay 暴露固定地址                    |
+--------------------------------------------+
          |
          v
   跑在某个玩家电脑上的真实服务端
```

**关键：Panel 一行都不用改。** 它以为自己连的是 Wings，我们给它一个行为一致的实现。

---

## 三、契约：我们的后端必须"长得像 Wings"

这是从 `wings/router/router.go` 原文抄下来的真实路由表。我们的 daemon 要逐个实现：

### 3.1 认证方式（必须照抄）

Wings 的中间件原文逻辑：

```go
auth := strings.SplitN(c.GetHeader("Authorization"), " ", 2)
if len(auth) != 2 || auth[0] != "Bearer" { ... 401 ... }
// 用常数时间比较 config 里的节点 token
subtle.ConstantTimeCompare([]byte(auth[1]), []byte(config.Get().Token))
```

**结论：** 所有 Panel 发来的请求都带 `Authorization: Bearer <节点token>`，
我们用**常数时间比较**校验。少数路由（下载/上传/WS）走 **JWT**，公开可访问。

### 3.2 必须实现的路由（完整清单）

```text
# --- 公开（签名 URL / JWT 授权）---
GET  /download/backup              下载备份
GET  /download/file                下载文件
POST /upload/file                  上传文件
GET  /api/servers/:server/ws       控制台 WebSocket（JWT）
POST /api/transfers                另一个 daemon 迁入（JWT）

# --- 需要 Bearer token ---
POST   /api/update                 更新配置
GET    /api/system                 节点系统信息（CPU/内存/磁盘）
GET    /api/servers                列出本节点所有服务器
POST   /api/servers                创建一个服务器
DELETE /api/transfers/:server      取消迁移
POST   /api/deauthorize-user       踢下线某用户

# --- 服务器级 ---
GET    /api/servers/:server        服务器详情
DELETE /api/servers/:server        删除服务器
GET    /api/servers/:server/logs   日志
POST   /api/servers/:server/power  开机/关机/重启/强杀
POST   /api/servers/:server/commands 发送控制台命令
POST   /api/servers/:server/install  安装
POST   /api/servers/:server/reinstall 重装
POST   /api/servers/:server/sync     同步配置
POST   /api/servers/:server/ws/deny  拒绝 WS token
POST   /api/servers/:server/transfer 开始迁移
DELETE /api/servers/:server/transfer 取消迁移
GET    /api/servers/:server/files/contents        文件内容
GET    /api/servers/:server/files/list-directory  目录列表
PUT    /api/servers/:server/files/rename          重命名
POST   /api/servers/:server/files/copy            复制
POST   /api/servers/:server/files/write           写入
POST   /api/servers/:server/files/create-directory 建目录
...（压缩/解压/删除/上传等）
```

**好消息：** 其中**文件、备份、日志、控制台 WS、系统信息**这些是"皮和血肉"，
直接照 Wings 的行为实现即可，和我们的分布式内核无关。

**只有这几条**需要接我们的内核：

| 路由 | 原生行为 | 我们的行为 |
| --- | --- | --- |
| `POST /api/servers` | 在**这台机器**上创建目录和容器 | 向 Coordinator 注册一个房间 + 申请租约 |
| `POST .../power` | 原地启停 Docker 容器 | **拉取最新快照 → 开服 → 挂 relay 隧道**；或正常移交 |
| `POST .../transfer` | 把容器迁到另一台 daemon | 触发**租约移交**：保存检查点 → 换 epoch → 新主机接管 |
| `GET  /api/servers` | 列出本机容器 | 列出**本机当前是不是主机**的服务器 |

---

## 四、为什么这招能"所有外在功能都正常"

因为这两类东西被干净地分开了：

1. **与游戏无关的功能**（登录、权限、UI、文件浏览、备份记录、计划任务、API 文档、审计日志）
   → 全在 Panel 里，**我们一行不改**。
2. **与"服务端在哪跑"有关的功能**（开服、停服、控制台、世界文件）
   → 在 Wings 的 API 后面。**我们换掉 Wings，自己实现这套 API**。

Panel 对世界的认知是："我有一个节点，节点上有一台服务器，可以 power/logs/commands/files"。
**只要我们的后端对这些请求给出正确的回答，Panel 完全不知道世界其实跑在玩家电脑上。**

---

## 五、改造清单（分阶段）

### Phase A：冒充 Wings（不改 Panel）
- [ ] 新建 `apps/nomad-wings`（Rust，axum）
- [ ] 实现 Bearer 认证 + `/api/system` + `/api/servers` 列表
- [ ] 让 Panel 能"连上这个节点"并在 UI 里看到它（这是第一个里程碑：**皮先接通**）

### Phase B：把"开服"接到我们的内核
- [ ] `/api/servers/:id/power` → 走 Coordinator 的 claim/lease
- [ ] 开机前从 SnapshotStore 恢复世界，关机前提交检查点
- [ ] 启动脚本接 `nomad-agent` 的 supervisor
- [ ] 控制台 `/ws` 转发真实服务端 stdout/stdin

### Phase C：补齐"血肉"
- [ ] 文件 API（浏览/编辑/上传/下载/压缩/解压）
- [ ] 日志接口
- [ ] 备份：跟我们的 SnapshotStore 对接（列表/创建/下载/删除/恢复）
- [ ] SFTP（可选，Wings 用现成库，我们也可以）

### Phase D：换掉本地 Docker，接远程中继
- [ ] 把服务端"绑定地址"从容器端口换成 relay 隧道
- [ ] 注册 slot 到 relay，让玩家从固定域名进
- [ ] 迁移（transfer）对接租约移交

---

## 六、必须想清楚的三个点

### 6.1 每个玩家机器装的是"我们的 Wings"，不是原生 Wings

**这是整个方案的前提。** 玩家装我们的 `nomad-agent`（将来打包成 Windows 安装程序），
它内部启动一个"像 Wings"的 API 服务，Panel 把它登记为一个"节点"。

### 6.2 一台"服务器"会跟着人跑，但 Panel 以为它固定在某个节点

Panel 的数据模型是"服务器属于某个节点"。而我们的世界会换主机。
两种做法：

| 做法 | 说明 | 代价 |
| --- | --- | --- |
| **A. 用 Panel 的 transfer 机制** | 世界换主机 = 触发一次 transfer，Panel 看到"服务器从节点A迁到节点B" | 最贴合 Panel 语义，UI 有原生显示 |
| **B. 每台机器都"看到"这台服务器** | 所有节点都向 Panel 报告拥有它，靠 epoch 保证只有一台真在跑 | 需要小心 Panel 的状态显示 |

**推荐 A**：Panel 原生支持迁移，UI 会显示"正在迁移"，正好对应我们的移交过程。

### 6.3 许可证与商标

- 代码：Panel 和 Wings 都是 **MIT**，改、闭源、商用都行（保留版权声明）。
- 商标：`Pterodactyl®` 是注册商标。**成品必须换名、换 logo、换品牌**，不能自称 Pterodactyl。
  我们已经有 `NomadCraft` 这个名字，直接用。

---

## 七、下一步（建议立刻做）

1. **克隆一份 Pterodactyl Panel 跑起来**（Docker Compose 最快），确认 UI 能开。
2. **写一个最小的 `nomad-wings`**，只实现 `/api/system` 和 `/api/servers`，
   让它能被 Panel 当成节点接上。
3. 接通那一刻，你就看到"**一个成熟的 MC 服务器面板，连着一个假的节点**"——
   皮已经到手，接下来只剩往核里填我们的东西。

---

## 附录：本次核实的数据来源

- pterodactyl/panel：https://github.com/pterodactyl/panel （MIT，9,292 star）
- pterodactyl/wings：https://github.com/pterodactyl/wings （MIT，1,056 star）
- Wings 路由表：https://github.com/pterodactyl/wings/blob/develop/router/router.go
- Wings 认证：https://github.com/pterodactyl/wings/blob/develop/router/middleware/middleware.go
- pelican-dev/panel（AGPL，排除）：https://github.com/pelican-dev/panel
- MCSManager：https://github.com/MCSManager/MCSManager （Apache-2.0）
- PufferPanel：https://github.com/pufferpanel/pufferpanel （Apache-2.0）
