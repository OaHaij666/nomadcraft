# 底座改造方案 v2：MCSManager 当皮，换掉"实例执行"内核

> 修正 v1 的错误：Pterodactyl 是 PHP + Laravel + MySQL，栈又老又重，一个面板要拖一整套基础设施。
> 换成 **MCSManager**：高星、现代栈、架构同样是"前台/面板/daemon"三层分离，缝一样干净，但没有历史包袱。

---

## 一、选型：MCSManager

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/MCSManager/MCSManager |
| Star | **4,981** |
| Fork | 550 |
| 许可证 | **Apache-2.0**（可改、可闭源、可商用） |
| 语言 | **TypeScript**（后端 Node + 前端 Vue 3） |
| 创建 | 2017-11-12（近 9 年历史） |
| 最近提交 | 2026-10-08（活跃） |
| 代码量 | 648 个文件，21.2 MB |

### 为什么是它

1. **现代栈，无历史包袱**：纯 TS + Node，不需要 PHP / Laravel / MySQL / Composer。
2. **架构天生三层分离**：
   - `frontend/` — Vue 3 前台（**这就是要保留的"皮"**）
   - `panel/` — 中心 API（用户、权限、实例元数据）
   - `daemon/` — 每台机器上的后端（**这就是要换的"核"**）
3. **高星 + 9 年沉淀**：不是新项目，踩过的坑都在里面。
4. **国内项目**：自带中文，文档/社区对你们更友好。

### 为什么不用别的

| 候选 | 否决理由 |
| --- | --- |
| pterodactyl/panel | PHP + Laravel + MySQL，栈老且重（用户已否决） |
| pelican/panel | 是 Pterodactyl fork，还要更糟：**AGPL-3.0** |
| pufferpanel | Go 写的，1,753★，但前台是传统模板渲染，UI 完成度不如 MCSManager |
| calagopus/panel | 只有 775★，太新，不宜当底座 |
| opanel-mc/opanel | 303★，且是**游戏内插件**（跑在 Paper 里），不是独立面板 |

---

## 二、现状：MCSManager 本来怎么跑

```text
  浏览器
    |
    v
+---------------------+
| frontend (Vue 3)    |  <-- 皮：所有页面
+----------+----------+
           | HTTP API
           v
+---------------------+
| panel (中心 API)     |  <-- 用户/权限/实例元数据/远程节点管理
+----------+----------+
           | 远程守护进程协议
           v
+---------------------+
| daemon (每台机器)    |  <-- 核：真正启动游戏进程
|  system_instance.ts |      execPreset("start"|"stop"|"kill")
|  docker_process_... |      或跑在 Docker 容器里
+----------+----------+
           v
    本机进程/容器里的 Paper/Fabric
```

### 关键代码位置（我实际看的文件）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `daemon/src/service/system_instance.ts` | 355 | **实例生命周期：启停、自动重启** ← 内核 |
| `daemon/src/service/docker_process_service.ts` | 751 | Docker 容器化启动 |
| `daemon/src/service/system_instance_control.ts` | 276 | 启停控制逻辑 |
| `daemon/src/service/system_file.ts` | 412 | 文件管理 ← 血肉，保留 |
| `daemon/src/service/mod_service.ts` | 483 | 模组管理 ← 血肉，保留 |
| `daemon/src/routers/Instance_router.ts` | — | 实例 API 路由 |
| `daemon/src/routers/file_router.ts` | — | 文件 API 路由 |

**要换的只有 `execPreset("start")` 那一层**——从"在本机 spawn 一个进程"换成
"向 Coordinator 申请租约 → 恢复世界快照 → 启动 → 挂中继隧道"。

---

## 三、改造后的形态

```text
  浏览器
    |
    v
+---------------------+
| frontend (Vue 3)    |  <-- 一行不改，品牌换成 NomadCraft
+----------+----------+
           v
+---------------------+
| panel (中心 API)     |  <-- 大体保留；加"房间"概念与租约状态
+----------+----------+
           v
+-------------------------------+
| daemon (NomadCraft 版)         |  <-- 换掉内核
|  对外：和原 daemon API 完全一致   |     皮的血肉（文件/备份/日志/终端）全部保留
|  对内：                         |
|    - 不再无条件本机开服           |
|    - 先向 Coordinator 抢租约      |
|    - 从 SnapshotStore 恢复世界    |
|    - 启动后注册 relay 隧道        |
|    - 定期提交检查点               |
+-------------------------------+
```

---

## 四、改造清单

### Phase 1：跑起来原版（建立基线）
- [ ] 装 Node，在 vendor/mcsmanager 里 build + 启动 frontend/panel/daemon
- [ ] 确认能创建实例、能启停、能看到控制台（**先有对照物**）

### Phase 2：接我们的内核
- [ ] `daemon` 启动前：向 Coordinator `claim` 租约
- [ ] 启动前：从 SnapshotStore 恢复世界到实例目录
- [ ] 启动后：向 relay 注册 slot（固定域名进房间）
- [ ] 运行中：定时 checkpoint + 提交（复用我们已有的 `nomad-snapshot`）
- [ ] 停止时：先保存检查点再移交租约

### Phase 3：改品牌与外观
- [ ] 全站文案/logo 换成 NomadCraft（Apache-2.0 允许，但须保留版权声明）
- [ ] 把"节点"话术改成"房间/主机"，符合我们的产品语义

### Phase 4：清理
- [ ] 删掉用不上的：Docker 相关（如果确定不用）、我们不再需要的旧骨架代码

---

## 五、许可证与法律

- **Apache-2.0**：可以修改、可以闭源分发、可以商用。
- **必须做**：保留原始 LICENSE 和版权声明（NOTICE）；标注我们改了什么。
- **不能做**：使用它的商标/品牌名。`MCSManager` 的名字不能直接拿来当我们的产品名 → 用 **NomadCraft**。

---

## 六、下一步

1. 装 Node 依赖，把 MCSManager 原版跑起来（建立基线）。
2. 读 `daemon/src/service/system_instance.ts`，确定切入点的最小改法。
3. 把我们的 Coordinator 接进去。

---

## 附录：本次核实的数据

- MCSManager：https://github.com/MCSManager/MCSManager （4,981★，Apache-2.0）
- 提交：cf49b64 docs: add openspec specs for user, instance, and file modules
- 目录：frontend / panel / daemon / common / docs
- 内核文件：daemon/src/service/system_instance.ts（355 行，execPreset 启停）
