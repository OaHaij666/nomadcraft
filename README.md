# NomadCraft / KAMUCL NC

面向朋友联机的 Minecraft 项目。KAMUCL NC 是桌面客户端；NomadCraft 后端负责实例、账号权限、计算节点、网络入口和已提交的存档。游戏服务端运行在玩家电脑或服务器计算节点上。

目前已验证原版托管、正常停服回传与恢复、云端实例文件发布和同步、环境跨云推送。Forge / Fabric / NeoForge 托管和客户端自动准备仍在开发；更换计算者不断线尚未实现。实现与验收记录保存在本地 docs/implementation/，不上传 GitHub。

## 项目目录

| 目录 | 内容 |
| --- | --- |
| `apps/` | Rust 执行器、控制面原型、转发与快照命令行工具 |
| `crates/` | Rust 协议、Minecraft 协议及存档同步公共库 |
| `vendor/kamucl/` | KAMUCL NC 桌面客户端源码 |
| `vendor/mcsmanager/` | NomadCraft 后端及内置云端管理界面源码 |
| `vendor/minecraft-numen/` | AI 陪玩基础项目源码 |
| `scripts/dev/` | 本地开发启动入口 |
| `scripts/verify/` | 跨模块、真实进程和界面验收脚本 |
| `docs/` | 仅本地保存的产品、设计、实现、研究和验证记录（不提交） |
| `.nomad/` | 不提交 Git 的本地配置、缓存、诊断日志及备份 |
| `target/` | Cargo 自动生成的构建缓存 |

本地文档索引位于 docs/README.md，目录约定位于 docs/project-layout.md；docs/ 不纳入 Git。源码树保持原构建路径；不要把运行数据或临时截图放在根目录。

## 本地开发

在各子项目中安装依赖后，从项目根目录执行：

```powershell
npm --prefix vendor/mcsmanager/panel run dev
npm --prefix vendor/mcsmanager/frontend run dev
npm --prefix vendor/kamucl run dev
```

构建客户端（先构建内置云端界面）：

```powershell
npm --prefix vendor/mcsmanager/frontend run build
npm --prefix vendor/kamucl run build
node vendor/kamucl/node_modules/electron/cli.js scripts/dev/start-client.cjs
```

这个客户端入口使用 `.nomad/runtime/desktop/` 中的开发配置，保留已有账号配置、角色卡、模型和游戏文件。后端原有数据仍在 `vendor/mcsmanager/panel/data/` 与 `daemon/data/`，没有迁移或清空。

## 验证

```powershell
node scripts/verify/workspace-layout.cjs
npm --prefix vendor/mcsmanager/panel test
npm --prefix vendor/mcsmanager/frontend test
cargo test -p nomad-agent
node scripts/verify/instance-distribution.mjs
```

Electron / 浏览器验收脚本使用 Playwright；可通过 `NC_PLAYWRIGHT_MODULE` 指定已安装的模块路径。完整入口见 [验证脚本说明](scripts/README.md)。不要递增客户端版本或发布安装包来代替验证。

## 产品与许可

产品和同步设计文档仅保存在本地 docs/，不上传 GitHub。

- [贡献说明](CONTRIBUTING.md)

根项目采用 MIT；各基础项目及第三方代码保留自己的许可，见对应源码目录。
