# 开发与验证脚本

从仓库根目录执行。

| 入口 | 用途 |
| --- | --- |
| dev/start-client.cjs | 通过 Electron 使用已有 .nomad/runtime/desktop 配置启动客户端 |
| verify/workspace-layout.cjs | 检查目录结构、脚本路径、文档链接与根目录杂物 |
| verify/instance-distribution.mjs | 两个独立后端的发布、断点续传和跨云环境推送 |
| verify/bots-approval.cjs | 隔离后端与真实桌面的机器人准入、YSM 审核、授权队列与多 harness 验证；游戏和模型接口为合成测试服务 |
| verify/numen-matrix.cjs | 真实 1.20.1 Fabric／Forge、1.21.1 NeoForge 专用服的适配加载、公有身体、Lua、退出恢复；没有图形客户端握手声明 |
| verify/gateway-settings-ui.cjs | 实际后台存储与浏览器：管理员网关保存、重新打开、端口冲突中文提示、桌面/手机布局，不启动游戏 |
| verify/handover-http.cjs | 真实认证 HTTP、计算节点、网关 JVM 和 WebSocket 的固定节点交接、最终快照和关房；世界 ZIP 为合成数据，不启动 Minecraft |
| verify/handover-live.cjs | 真实后端 HTTP、两个 Rust 节点、固定网关与实际玩家的交接；支持 `--remote-target` 将目标节点放到 SSH 服务器，以及 `--public-bot --lifecycle` 验证公有 Harness 重启恢复 |
| verify/gateway-handover.cjs | 真实 1.20.1／1.21.1 原版或 Fabric 玩家经 Velocity／LimboAPI／Reconnect 等待旧服停机、返回新进程；同一个 TCP 连接、玩家 UUID 和位置。回环离线验证，不代表模组握手／正版转发已验收 |
| verify/numen-server.cjs | 实际 Minecraft / 上游 Numen 发布版：原生准入、真实玩家身份、代召唤、公有服务器 Harness 与定向任务；模型回复为测试桩 |
| verify/numen-ysm.cjs | 实际 YSM 发布版：热重载完成回执、公有机器人模型查询和应用后回读，不代表图形客户端渲染验收 |
| verify/cloud-prepare.cjs | 真实 Electron 与隔离后端的自动安装、绑定、同步、冲突及只读账号验收；客户端下载为合成测试文件 |
| verify/cloud-client.cjs | 真实 Electron 的云端导航、发布、同步、托管与节点配对 |
| verify/vanilla-hosting.mjs | 原版服务端转发、检查点与二次恢复 |
| verify/compute-network.mjs | 计算节点、网络入口和两次托管 |
| verify/browser-compute-ui.cjs | 浏览器中的节点配对、网络自检及房间设置 |
| verify/browser-hosting-preference.cjs | 托管意愿的浏览器验收 |
| verify/rust-smoke.ps1 | 原始 Rust 控制面和执行器的进程级冒烟验证 |

前端/后端及客户端须先完成各自构建。浏览器和 Electron 脚本需要 Playwright，可设置 NC_PLAYWRIGHT_MODULE；Java 托管验收可设置 NC_TEST_JAVA。浏览器入口按机器环境配置，不提交本机账户或凭据。

~~~powershell
node scripts/verify/workspace-layout.cjs
node scripts/verify/instance-distribution.mjs
node scripts/verify/cloud-client.cjs
~~~

本地日志、临时截图与报告放在 .nomad/diagnostics/；人工确认后才将最终证据收入 docs/。

自动准备验证可设置 `NC_TEST_REAL_CLIENT=1` 下载真实 Minecraft 1.20.1 客户端；默认使用合成文件快速验证安装和同步流程，两种模式均不启动游戏。

网关验证先执行 `node apps/gateway/build.cjs`。依赖缓存位于 `.nomad/cache/gateway`，制品与 SHA-256 见 `apps/gateway/prepare.cjs`。真实服务端矩阵可用 `NC_NUMEN_TARGET` 选择组合，`NC_TEST_PROXY` 仅为验证下载指定现有代理，`NC_TEST_JAVA_DIRECT=1` 让 Java 安装器使用直连。

`NC_GATEWAY_MC=1.20.1` 或 `1.21.1` 选择网关验证版本；`NC_GATEWAY_FABRIC=1` 验证 Fabric＋Numen 和 signed modern forwarding。每个组合使用独立诊断目录和报告。`node --test apps/gateway/runtime.test.cjs` 检查离线测试范围、制品校验和未知转发配置保留。

网关测试增加 `NC_GATEWAY_CONTROL=1` 可调用实际 NomadGateways 服务准备入口和后端制品（要求 Fabric 测试模式），报告单独标记 controlGateway；不等于完整 HTTP 开房和正版认证已验证。

`NC_GATEWAY_SAVED=1` 在 control+fabric 网关测试中使用存档设置装载网关，报告单独标记 savedRoomSettings。

`NC_NUMEN_FORWARDING=1` 给 numen-matrix 的隔离服务端加上匹配转发组件，再验证适配和 Numen 生命周期；结合 `NC_NUMEN_TARGET` 可单独验证 Forge／NeoForge，报告按目标独立保存。这不代表图形客户端握手验收。

真实跨机器联调使用 `--remote-target=<已配置的 SSH 主机名>`，主机凭据从用户目录 `.mcp-remote-ssh/config.json` 读取，不写入仓库。`--ssh-module=<ssh2 模块路径>` 可使用现有工具环境的依赖。远程预先准备独立的 `~/nomadcraft-integration/source/target/debug/nomad-agent` 与 `runtime/java17`、`runtime/java21`。控制面通过 SSH 反向回环隧道访问，玩家仍连接本地固定网关；退出时停止本轮节点并删除远程节点凭据。`--seed-installer-cache` 只向独立目录提供缓存，原加载器安装器仍负责校验和生成运行文件。

Fabric 可在 `handover-live.cjs` 传入 `--graphical` 使用真实图形 Minecraft 客户端（默认 Fabric 验证器使用协议玩家）。先用 `modded-client-prepare.cjs --target=<版本-loader>` 准备对应运行缓存；四个组合均通过启动器原安装流程准备。图形和后端重启生命周期证据分别写入 `*-public-graphical.json` 和 `*-public-lifecycle.json`，避免互相覆盖。

`scripts/dev/build-vanillacord.cjs` 使用固定提交和 SHA-256 的原 VanillaCord／Bridge 源码构建身份转发补丁器；传入 `--maven=<mvn.cmd 或 mvn>`、`--java-home=<JDK>`，可选 `--settings=<Maven settings.xml>`、`--proxy=<HTTP 代理>`。构建缓存归入 `.nomad/cache/vanillacord-build`，补丁器和来源清单写到 `apps/gateway/.cache`。`apps/gateway/vanilla.cjs` 保留官方原始 JAR，对独立输出应用补丁；后端部署包保留官方原始 JAR，另含转发运行文件；Rust 节点分别校验并选择运行文件。`NC_GATEWAY_VANILLACORD=1` 可在现有网关验证中测试诊断目录内已准备的补丁版服务端。

`handover-live.cjs --target=1.20.1-vanilla` 或 `1.21.1-vanilla` 支持原版自动部署和双节点真实 HTTP 交接；仍使用隔离离线游戏身份，协议测试不代表图形客户端／正版认证验收。原版模式不安装 Numen。`NC_GATEWAY_UI_VANILLA=1` 可用 `gateway-settings-ui.cjs` 验证原版实例网关配置保存、重开及端口冲突。

原版两版本同样支持 `--graphical`：先执行 `modded-client-prepare.cjs --target=1.20.1-vanilla` 或 `1.21.1-vanilla`，安装选项省略加载器，客户端不装桥接 MOD。图形驱动读取隔离启动器的 `running-game.json` 确认本轮游戏 PID，再检查原 TCP 四元组和目标服玩家恢复；证据输出 `handover-live-proof-<版本>-vanilla-graphical.json`。

`verify/numen-integrated.cjs --target=<版本-loader>` 使用真实图形客户端打开独立诊断单人世界，通过启动器控制台连接原 MCP、运行私有 Harness，并检查机器人休眠／重新加入的真实身体状态和原 UUID、关闭游戏后适配清理。仅拷贝诊断世界和不可变运行缓存，不读取用户存档或账号；模型回复为本机测试接口。支持四个目标组合。

`handover-live.cjs --target=1.21.1-fabric --graphical --ysm` 将实际 YSM 2.6.5 发布版加入新的固定发布版，明确绑定测试存档，上传默认 ZIP 模型资源并保留待审核状态；计算节点启动后才批准模型，检查真实节点热重载和上游 Lua 的模型／贴图回读。仅隔离测试观察玩家具有 OP 权限，用于独立图形验收；模型显示以实际游戏截图为准；普通玩家换主机证据仍单独保留。必须人工查看 `graphical-ysm-source.png`、`graphical-ysm-target.png` 才能声明显示正确。报告单独命名为 `*-ysm-public-graphical.json`，游戏身份仍为隔离离线测试身份。

`handover-live.cjs --microsoft --target=1.20.1-fabric --remote-target=<SSH 主机名>` 复用已经打开的启动器和选中的 Microsoft 正版账号，要求它启用了本机调试端口（开发验证用 `--remote-debugging-port=0`）。可用 `--signed-profile=<userData 路径>` 指定该启动器配置位置。验证器只读取公开的账号类型、名字和 UUID；游戏仍通过原启动器主进程刷新凭据并启动。云端准备在另一份隔离配置中完成，测试游戏目录临时登记后解除登记，不复制账号文件、不改现有云端登录、不结束其他游戏。没有正版账号、已有游戏仍在运行、或开启了启动后关闭窗口时，预检明确拒绝启动。实际网关必须启用在线认证、玩家密钥和 modern forwarding，报告单独命名为 `*-microsoft-public-graphical.json`；预检通过或边界测试通过均不等于正版游戏交接已验收。

`--native-close` 可以在离线诊断回归中验证定向窗口关闭。它只向匹配本轮诊断目录的 Java 游戏窗口发送关闭请求，并确认进程退出。正版模式自动采用这一方式，保留原启动器窗口。

跨机器验证传入 `--proxy=http://127.0.0.1:<端口>` 时，本轮 SSH 私有回环隧道也会让远程 Java 使用同一下载代理；不改服务器全局代理，退出时解除隧道。只接受不含凭据和额外路径的本机 HTTP 代理。


设置 `NC_TEST_RESOURCE_DISTRIBUTION=1` 后运行 `verify/cloud-prepare.cjs`，会在隔离后端和桌面配置中验证自动资源分发：使用真实固定版 Fabric API 0.92.2+1.20.1，不在发布清单中预设来源；由后端自动识别，启动器从真实 CDN 下载。仅在隔离后端记录不含凭据的文件下载请求路径，断言公开 MOD 不从云端下载、自定义配置从云端下载，并验证缓存补齐、重复准备及文件更新。`NC_TEST_PROXY` 指定本次下载代理，默认本机 7897；`NC_PLAYWRIGHT_MODULE` 指定已安装的 Playwright。报告为 `.nomad/diagnostics/reports/resource-distribution-desktop-proof.json`。此流程使用合成的 Minecraft 运行文件验收安装与同步，不启动游戏，也不代表正版认证或游戏兼容性验收。
