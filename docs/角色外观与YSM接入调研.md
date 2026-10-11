# 角色外观与 YSM 接入（2026-10-11）

基于本地 Numen 源码固定版本 2df6979ec33ae45edd623c512ee6644dd94ef11a。未改动 Numen 模组源码。

## 已实现的启动器功能

- AI 陪玩 → 角色卡库改为角色卡网格，显示名字和普通 Minecraft 的 3D 皮肤；点击进入设置。
- 每页最多 8 张卡片，离开页面销毁预览，避免角色库无限创建 WebGL 上下文。
- 名称、头像、自由 Markdown 人设保持原有逻辑；外观不混入 persona 提示词。
- PNG 皮肤导入、标准/纤细手臂切换、本地立体预览、恢复默认、原始 PNG 导出。
- 支持 64×64、64×32 PNG，最大 1 MiB。皮肤单独存储在角色卡 appearance.skin 中。
- YSM 模型 ID、可选贴图 ID存入 appearance.ysm；JSON 导入导出与复制保留外观，Markdown 仅导出人设正文。
- 连接游戏、选择同伴并停止陪玩后，可读取 YSM 已授权模型清单和当前模型的贴图，或将已保存的卡片外观应用到所选同伴。
- YSM 操作通过原有 MCP lua 工具执行，不调用模型、不消耗 AI tokens。目标固定为明确选中的同伴，沿用 Numen / YSM 主人权限。
- 切换后回读 current_model / current_texture，匹配所选值才显示确认。错误和不完整清单显示失败。

## 普通皮肤：能预览，当前 MCP 不能直接应用

Numen 的原生皮肤库存放在 config/numen/skin.json，原图在 config/numen/skins/。上传皮肤经 MineSkin 获取 Mojang 签名，条目带 value 和 signature。

游戏内设置通过 ChangeSkinPayload 自定义网络包发送皮肤数据，校验主人权限，随后重新生成同伴以更新外观。现有 MCP 工具和 Lua API 未暴露这一调用；仅将 PNG 存到角色卡不能让在线同伴换皮肤。

因此本次 UI 明示本地预览，提供 PNG 导出，使用游戏内 Numen 皮肤面板完成导入与签名。没有静默上传图片到 MineSkin，也没有把“人设绑定成功”显示为“皮肤应用成功”。若需要启动器内一键应用普通皮肤，需要另加模组桥接或由上游开放接口。

依据：
- numen-api/common/src/client/java/com/dwinovo/numen/api/client/skin/SkinLibrary.java
- 同目录 MineSkinClient.java
- numen-api/common/src/main/java/com/dwinovo/numen/api/network/payload/ChangeSkinPayload.java
- numen-api/common/src/client/java/com/dwinovo/numen/api/mcp/server/McpServer.java

## YSM：现有普通皮肤组件不能直接渲染，独立查看器有可复用实现

上游 YsmApi 提供 ysm.model.options()、ysm.model.switch(model, {texture = ...})、ysm.model.emote(animation)。Java record 字段经 LuaCodecs 转换为 snake_case，Lua 查询使用 current_model / current_texture，不能照抄 Java camelCase。

options 通过 YSM 命令补全返回玩家有权使用的模型 ID、当前模型贴图；switch 通过 YSM 命令换装并回读同伴 NBT。无需启动器解析加密模型。

YSM 联动未提供几何、材质、骨骼或动画数据的下载/预览接口。KAMUCL SkinViewer3D 是标准 Minecraft 方块人体，无法直接渲染任意 YSM 骨骼模型。本次保留游戏内预览，界面明确标注左侧和卡片内为普通皮肤示意。结论限于当前启动器组件和上游接口，不代表将来无法实现独立 YSM 渲染器。

贴图清单仅属于游戏当前所穿模型。切到另一模型后重新读取，可获得新模型贴图。动作清单亦未由 YSM 提供，本次未虚构动作列表。

依据：
- plugins/ysm/src/main/java/com/dwinovo/numen/plugins/ysm/YsmApi.java
- 同目录 Ysm.java、OwnerSync.java
- plugins/ysm/src/main/resources/plugins/ysm/skills/ysm_look/SKILL.md
- numen-api/common/src/main/java/com/dwinovo/numen/api/sdk/LuaCodecs.java

## 验证边界

类型检查、构建、角色持久化/PNG 校验/Lua 参数编码/回执解析测试，以及真实 Electron 客户端视觉与操作验证。使用隔离用户目录和本地 HTTP MCP 测试服务验证查询、目标同伴、切换回读；未启动真实 Minecraft + YSM 环境，未调用付费模型或 MineSkin。


## 补充调研：现成 YSM 预览项目（2026-10-11）

上一轮只查了 Numen 接口与 KAMUCL 标准皮肤组件，未继续调查独立 YSM 查看器，范围不充分。现已查到：

| 项目 | 已核实能力 | 技术栈与复用方向 |
| --- | --- | --- |
| DrAbcOfficial/YSMViewer | 直接打开 .ysm、跨平台 3D 查看，提供浏览器版 | Avalonia/.NET，浏览器通过 Three.js 渲染；适合作为渲染几何/骨骼行为参考 |
| eghrhegpe/ysm-model-manager | 模型加载、Three.js 预览、纹理切换、独立 YSM 骨骼动画播放器 | TypeScript + Three.js + YSMParser WASM；与现有 Electron/Vue/Three.js 更贴近，是优先研究的提取对象 |
| OpenYSM/YSMParser | .ysm 解析、资源还原、WASM 构建 | 解析层，不能单独替代预览渲染器；仓库声称广泛格式支持，实际兼容性须以样本验证 |

源码核对固定版本：
- ysm-model-manager：f8d08bba123559ff8d7462dd171fc5cc2d5162a9
- YSMViewer：a30baf27425a9cc206af095600e3d98e4eb7f472

已查源码入口：
- https://github.com/eghrhegpe/ysm-model-manager/blob/f8d08bba123559ff8d7462dd171fc5cc2d5162a9/frontend/src/preview-3d/adapters/ysm-adapter.ts
- 同版本 frontend/src/preview-3d/model/ysm-animation-player.ts：createYsmAnimPlayer、selectClip、apply、setController；支持 rotation/position/scale 和动画混合。
- 同版本 docs/knowledge/ysm-anim-pipeline.md：解析、求值、适配器注入的调用链。
- 同版本 NOTICE：主项目标注 Apache-2.0；YSMParser 和 MolangJS 标注 MIT。
- https://github.com/DrAbcOfficial/YSMViewer ：主项目 GPL-3.0，存在 YSMViewer.Browser/Rendering/ThreeJs 和独立动画服务。
- https://github.com/OpenYSM/YSMParser ：MIT，提供 CMake WASM 构建。

注意 ysm-model-manager 的部分 architecture.md 旧段落仍写“不支持动画”，但同一固定版本实际存在并使用 YSM 动画播放器与适配器，动画结论以源码及对应动画知识卡为准。主项目许可证也不能替代对待移植文件来源的逐项核对。

接入建议：本地模型文件/实例模型目录 → 本地 WASM 解码 → Three.js 骨骼与材质 → 角色卡预览；游戏内应用仍沿用已有 Numen YSM 接口。Numen 的模型 ID 只标识模型，不能取代模型文件；需要在本地解析同一份资源，或通过云端资源同步得到相应文件。WASM、脚本与渲染代码应随客户端打包，预览不依赖远程网站。

本轮完成普通皮肤卡片和详情的行走动画。YSM 预览项目仅完成调研与源码核对，尚未移入或运行其渲染器；不能宣称真实 .ysm 兼容测试通过。


## 当前接入状态：YSMViewer 替换与默认动作（2026-10-11）

通用本地导入入口接受 .ysm 和 YSM 模型 ZIP，无测试角色名称或配色硬编码。ZIP 路径/体积/循环骨骼校验继续由 archive.ts 执行，游戏安装仍使用原始资源。预览改为原版 YSMViewer.Core 解析 + ThreeJsPayloadBuilder + 浏览器渲染器，配套 Three.js/OrbitControls 本地打包，隔离 iframe 防止多个卡片共享场景。旧预览缓存首次访问从 source.bin 重新生成。

渲染器最小补丁、来源与依赖风险见 vendor/kamucl/licenses/ysmviewer/PATCHES.md。修复首次取景世界矩阵、不可见组件影响取景、动画路径绑定，默认从 Minecraft 正面取景。未求值的表达式关键帧跳过，不能宣称完整 Molang/controller 支持。暂停保留姿态。

默认配置可选择贴图和默认动作，默认动作保存到 defaults.json；首页以及相同默认模型的角色预览自动使用它。不同模型没有所选动作时自动回退。默认动作只影响启动器预览，不改游戏内行为。

官方 CC0 Default 模型 ZIP 包含 default（红衣）与 blue（蓝衣）两套人物贴图，选择来自模型包而非代码。实际加密 .ysm 和其他复杂模型仍需更多样本测试；自包含解析运行库当前仅 Windows x64。玩家皮肤自动应用仍未实现，仅自动安装模型资源，不能把它描述为已完成自动换肤。


## 角色卡模型跨实例自动准备（2026-10-11）

原件保存在启动器 userData/ysm-models/<SHA256>/source.bin，与实例分离；角色卡引用 assetId、游戏模型 ID 与贴图。绑定卡片、手动应用外观、开始陪玩时，共用 ensureCharacterYsm：校验资源身份→补齐当前实例 config/yes_steve_model/custom→查询游戏可用模型→缺失时调用 Numen numen.mc.run("ysm model reload")→有限重试确认识别→应用→回读确认。只复用相同文件，冲突拒绝且不覆写，失败不启动 AI、不提交新角色绑定。旧卡片只有模型 ID 时允许使用游戏已有模型，但不能凭 ID 自动复制缺失的资源。

角色编辑页提供独立模型库说明及“准备模型到当前实例”，游戏关闭时可提前安装，沿用空闲实例检查。实时追加模型文件只在显式角色外观流程中使用，模组 JAR 不会运行中写入。实际官方 YSM 2.6.5 NeoForge JAR 的 Brigadier 注册字节码核实存在 model→reload 子命令。该命令走原有 Numen 权限检查，无提权或绕过。

多人远程服务器：本地实例复制并不等同于服务器部署；若世界主机没有相应模型/授权，查询与回读不会通过并明确提示。云端服务端资源上传分发仍需独立实现，不能宣称本地复制已解决所有远程场景。

本轮43项相关测试通过，涵盖双实例原件保留、同名冲突、资源复用、绑定模型身份、缺失来源、权限失败、有限重试、外观回读。实际 Minecraft + YSM + Numen 联动仍未运行，不把测试服务回执当作真实游戏验证。
