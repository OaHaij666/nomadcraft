# 改造进度：MCSManager 基线已跑通

> 日期：2026-10-09
> 状态：**原版 MCSManager 完整跑起来了**，改造开始前的地基已就位。

---

## 一、已经做到什么

原版 MCSManager 的三个部分**全部编译并运行成功**：

```text
浏览器
  |
  v
http://localhost:23333   <-- Panel（中心 API，已挂载 Vue 前端，首页 200）
  |
  | WebSocket（自动发现 + key 校验成功）
  v
http://localhost:24444   <-- Daemon（守护进程，已连接，0 实例就绪）
```

### 验证证据

| 组件 | 证据 |
| --- | --- |
| daemon 构建 | `daemon/production/app.js` 4.0 MB，webpack 编译成功 |
| panel 构建 | `panel/production/app.js` 4.0 MB，webpack 编译成功 |
| 前端构建 | `frontend/dist` 57 个文件，Vite 构建成功 |
| daemon 运行 | 日志：'Daemon process has been successfully started'，监听 24444 |
| panel 运行 | 日志：'Control panel has started'，监听 23333 |
| 两端连通 | 日志：'key validation successful'，'Connected to remote daemon' |
| 前端挂载 | `GET http://localhost:23333/` → 200，含 `<script>` 和 MCSManager 页面骨架 |

### 环境与依赖（踩过的坑，记下来省得再踩）

1. **Node 版本**：需要 Node 24（本机 v24.16.0 ✓）。
2. **依赖安装顺序**：先根目录 `npm install`，否则 panel 找不到 `async-mutex` 编译失败。
3. **两个原生二进制**（必须手动下载，仓库里没有）：
   - `daemon/lib/pty_win32_x64.exe`（终端，来自 MCSManager/PTY）
   - `daemon/lib/file_zip_win32_x64.exe`（压缩，来自 MCSManager/Zip-Tools）
   - `daemon/lib/7z_win32_x64.exe`（解压，同上）
4. **前端要手动挂载**：构建 `frontend/dist` 后，必须拷到 `panel/public/`，
   否则 panel 只有 API、首页 404。

---

## 二、目录结构（现在长这样）

```text
minecraft/
├── crates/                 我们的 Rust 内核（保留）
│   ├── nomad-proto/        协议类型、租约、epoch
│   ├── nomad-snapshot/     世界快照 + 增量复制 + 保留策略
│   └── nomad-mcproto/      Minecraft 握手解析（中继用）
├── apps/
│   ├── control-plane/      协调器：谁当主机
│   ├── agent/              玩家侧代理
│   └── relay/              中继：固定地址门卫
├── vendor/
│   └── mcsmanager/         ← 底座的"皮和血肉"
│       ├── frontend/       Vue 3 前台（保留）
│       ├── panel/          中心 API（保留）
│       ├── daemon/         守护进程（**改造目标**）
│       └── common/         共享类型
└── docs/                   方案与调研
```

---

## 三、下一步：改造落点已定位

**唯一要动的地方**：

```text
vendor/mcsmanager/daemon/src/service/system_instance.ts   (355 行)
  └── execPreset("start" | "stop" | "kill")   ← 实际启动游戏进程的入口
```

**改造成**：

| 原行为 | 新行为 |
| --- | --- |
| 无条件在本机 spawn 进程 | 先向 Coordinator 申请租约（只有赢家能开服） |
| 直接用本地 world 目录 | 开服前从 SnapshotStore 恢复最新世界 |
| 服务端监听本地端口 | 启动后向 relay 注册 slot（固定域名进房间） |
| 进程退出即结束 | 退出前提交检查点、移交租约 |

**保持不变（血肉）**：文件管理、模组管理、日志、终端、备份、权限、UI。

---

## 四、Git 策略

- **纳入版本控制**：`vendor/mcsmanager` 的**源码**（647 个文件），改动可审。
- **排除**：`node_modules/`、`production/`、`dist/`、`daemon/data/`、
  `daemon/lib/*.exe`（这些都能重新生成/下载）。
- 见 `vendor/.gitignore`。

---

## 五、许可证提醒

MCSManager 是 **Apache-2.0**：可改、可闭源、可商用。
**必须保留**原始 LICENSE 与版权声明、标注我们改了什么。
**必须换名**：产品对外叫 **NomadCraft**，不能用 MCSManager 品牌。
