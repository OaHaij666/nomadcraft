# NomadCraft 固定连接网关

这个模块使用 Velocity、LimboAPI 和 Reconnect 的原始发布制品，负责在后端停服时保存代理连接、显示等待区，并在恢复后送回同一个房间。NomadGateway 是独立的登录生命周期插件，用于没有其他 Limbo 登录插件的环境。上游源码不在这里修改。

`node apps/gateway/build.cjs` 下载并校验固定依赖、编译独立插件，并把运行依赖打包到忽略的 dist。Java 21 或更高版本用于构建和运行网关；Minecraft 计算进程使用其自身匹配的 Java。

- `prepare.cjs`：校验配置，生成运行目录；默认使用正版认证和 modern forwarding。离线模式仅允许明确指定的回环测试。
- `backend.cjs`：准备按哈希固定的 FabricProxy-Lite／Proxy-Compatible-Forge，并生成转发配置；只允许在停机的独立执行器目录内使用，不替换未知配置。
- `runtime.cjs`：GatewayManager 管理自己启动的 JVM，提供 start/status/stop/close，不扫描或结束用户的其他 Java 进程。
- `src/`：独立的 NomadCraft 生命周期插件。
- `scripts/verify/gateway-handover.cjs`：真实 1.20.1 服务端进程、存档恢复、真实协议玩家和同一个 TCP 连接的交接验证。

当前已验证原版 1.20.1／1.21.1，以及 Fabric＋Numen 1.20.1／1.21.1 的隔离离线代理流程。Fabric 使用签名 modern forwarding，额外验证没有转发签名的直连玩家被后端拒绝。实际后端 HTTP、两台常驻 Rust 计算节点、最终存档提交/恢复和玩家原 TCP 连接保持已在 Fabric 1.20.1／1.21.1 完成联合验收。Forge／NeoForge 的真实图形客户端已验证入服、当前玩家快捷指令和保留原 TCP 连接的交接；其图形测试使用直接停服和复制最终存档，尚未代表两种加载器均已完成控制面 HTTP＋Rust 节点联合验收。正版身份验证仍需验收。依赖校验值和来源在 prepare.cjs，构建产物不纳入 Git。

## 控制面接入

后端构建会打包网关引擎、独立插件和固定的转发依赖，不要求客户端在线下载 JS。管理员在主机上创建配置文件（示例为本目录 config.example.json），使用环境变量 `NC_GATEWAY_CONFIG` 指向它，并通过 `NC_GATEWAY_JAVA` 指定 Java 21。配置指定云端实例/存档和公开入口，不包含用户 AI API 密钥。

开房时，已配置的模组房间自动启动网关，下载给执行器的部署包包含签名转发 MOD、对应配置以及文件哈希。网关在交接期间保留，内部中转端口只监听 127.0.0.1；主机切换后复用。正常关房会停止网关。publicHost/publicPort 可以指向既有公网、IPv6 或外部 TCP 映射；backendPort 为控制面主机的内部端口，不能与任何网关监听端口冲突。

公开的交接接口要求网关已配置且就绪。没有网关时会拒绝不断线交接，不会触发一个必然掉线的停服流程。管理员也可在实例中心的房间「计算与网络」中配置固定入口并开启「主机交接不断线」，填写内部中转端口。配置保存在存档记录中，开房时自动装载。配置不允许运行中修改，公共监听端口和内部端口在所有存档间共同保留。外部主机文件作为兼容选项保留；显式关闭房间网关会优先于该文件。原版的自动部署需要适配身份转发，不能直接使用未经适配的 Mojang server.jar；当前自动网关部署明确限定四种模组组合。完整正版账号流程和 Forge／NeoForge 的实际 HTTP＋Rust 节点联合交接仍在验收范围内。

`NC_GATEWAY_CONTROL=1 NC_GATEWAY_FABRIC=1 NC_GATEWAY_MC=1.21.1` 的验证脚本会调用实际 NomadGateways 服务准备入口和后端文件，再运行真实进程。该测试明确使用离线回环代理认证，不证明 Microsoft 登录；其余控制面 API 权限/部署包/中转任期另由后端测试覆盖。

`node scripts/verify/handover-live.cjs` 联合验证真实后端、常驻计算节点、发布版下载、真实 Minecraft 进程和真实协议玩家。`NC_HANDOVER_MC=1.21.1` 切换版本；必要时 `NC_TEST_JVM_ARGS` 可提供显式测试代理参数。验收的离线认证只存在于脚本生成的回环进程 preload 中，正常后端保持正版认证。脚本检查最终存档标记、UUID、位置、固定地址和原 TCP 连接，并正常关闭自己的房间及节点。协议测试不会据此声明图形客户端、物品/注册表解析或 Microsoft 登录已验收。

交接期间只有当前有效租约的既有隧道保留到 Minecraft 正常停机；拒绝新增到停止中节点的连接。正常关房、权限撤销和租约失效仍关闭隧道。旧代次完成最终存档提交后清理连接，保留固定入口等待目标接手。Fabric 1.21.1 自动部署会提供固定且校验过的 Fabric API；发布版已经有此 MOD 时按元数据 ID 跳过附加文件，即使用户改了文件名也不会重复安装。

Forge 1.20.1 首次连接由 Ambassador 完成模组登录协商。独立网关插件在 LimboAPI 接管前保留该流程，并避免首次选服时提前标记为已进入等待区；换主机时继续使用等待区。该兼容处理依赖当前固定的 Velocity 3.3.0-436、LimboAPI 1.1.26 和 Ambassador 1.4.5 的接口，更换依赖须重新执行真实 Forge 图形入服及交接验收。上游相关问题见 Elytrium/LimboAPI #89、#275。

NeoForge 1.21.1 的必需网络通道无法接受原版 Limbo 配置握手，因此交接时使用独立 NeoForgeHold：保留原 PLAY 世界，断开旧后端转发，以代理 KeepAlive 保持连接，显示中文等待提示，恢复后由真实 NeoForge 后端完成 CONFIG 协商。等待期间游戏计算暂停；等待超时、客户端离开和代理关闭会清理任务。封禁、白名单拒绝及认证失败不进入该等待流程。不能把相邻不同整合包的切换视为同一固定发布版的主机交接。

Forge 1.20.1 云端客户端自动准备/加入会安装启动器内置、哈希固定的原版 ForgeClientResetPacket 0.3.1，仅复制到本地客户端，不装到服务端。未知同名文件或不匹配的已有重置组件保留并报告错误；运行中的实例不能写入。

等待区 read-timeout 设为 45 秒；LimboAPI 的心跳间隔是该值的一半，即 22.5 秒。它需要小于常见客户端 30 秒心跳超时，避免 30 秒定时器之间发生竞争。更改等待区或代理超时时须重跑超过 30 秒的保留连接验收。

Forge 的原生握手保留同时覆盖首次选服和 ServerConnectedEvent：这两个时点都不能让 LimboAPI 提前替换 Ambassador 的会话处理器。真实 Forge 客户端已验证额外 40 秒无后端等待及恢复；NeoForge 同样通过 40 秒等待。最新 Fabric 后端 HTTP／两台常驻 Rust 节点联合回归也通过，使用明确的同机测试内存预留和 JVM 并发配置，实际容量检查保持启用。
