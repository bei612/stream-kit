# 发布与部署基线

核对日期：2026-11-14。本文集中维护可下载版本、现场部署和验收边界，避免在多份长期文档重复声明“当前版本”。预发布不等于全部生产验收通过。

## 可下载产品

| 产品 | 发布标识 | 运行源码 / 身份 |
| --- | --- | --- |
| Windows / Ubuntu 24.04 amd64 统一服务端 | [v0.1.0-preview.20261110.5](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261110.5) | `3d4a3b5c61fea72354318cea637b3428052e5cfc` |
| 签名 Android APK | [v0.1.0-android-preview.20261109.6](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-android-preview.20261109.6) | `df7cd87b3352a638aa3a6aa7073d39074c02a43c`；versionCode `1000013` |

服务端发布复用已核验的原始产品字节。验收脚本提交 `a2e8529b` 与运行源码身份分别记录，不因只改验收器重建运行时。原始文件名和 SHA-256 以对应 Release 附件及[精确发布材料](evidence/unified-installers-3d4a3b5c.json)为准；Android 见[APK 材料](evidence/android-release-20261109-6.json)。发布不会自动替换已有安装。

## 本机 Windows 部署

这是保留现有数据的组件维护部署，控制端与网关同源、Sunshine 保持原版本；不能描述成重新安装了最新统一包。

| 项目 | 本机值 |
| --- | --- |
| 管理控制端 | `3ae2c44dfe37d9061cfaed9d03166548cad16540`；保留统一响应式管理布局，加入资源生命周期修复 |
| 媒体网关 | `3ae2c44dfe37d9061cfaed9d03166548cad16540`；帧保留、连接释放与容量边界修复 |
| Sunshine | `47c02726c0161ebdec50911422d62845a9b6e59a` |
| Windows 服务 | `StreamKitOrchestrator`，自动启动，LocalSystem |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时的 LAN 管理入口 | `https://192.168.3.27:9000/login` |
| 网关 / 渲染端内部端口 | HTTPS `8080` / 原生 `48989`、管理 `48990` |

地址会随实际网络改变，表中 LAN IP 是核对时的现场值，不是程序内置地址。本机凭据仍在受保护配置中，不写入本文。

本机使用既有部署 CA，`server.lan_tls.hosts` 已包含核对时的 LAN 地址；管理端与网关共用该身份。本机及 LAN 管理登录页、LAN 网关页面已有严格 HTTPS 校验和实际 playwright-cli 页面检查记录。应用 ID、CA/CA 私钥和服务私钥保留；本次替换完整管理控制组件、媒体网关及配套 Web/WASM，Sunshine 二进制摘要保持。新 LAN 地址的完整媒体链路仍未重新验收。服务重启与配置维护不等于重新安装统一包或整机重启。

当前管理端的 8 个页面共用容器、标题、栅格、面板和响应式导航。已安装 HTTPS 页面通过桌面/手机全路由检查、真实配置展开和参数搜索、导航与断点检查；同一源码的独立原生后端验证覆盖平板、草稿保留、配置冲突及组件操作。维护规则见[管理端布局](management-layout.md)，精确范围见[布局验收](evidence/management-layout-a616beba.json)。本次没有重新执行媒体长跑，也未更新公开统一安装包。

## 已有验收及适用范围

2026-11-13 的[资源审查](evidence/runtime-resource-review-20261113.json)，源码 `3ae2c44dfe37d9061cfaed9d03166548cad16540`，已修复持续帧元数据保留、握手失败连接释放、媒体队列/浏览器缓冲、配对证书身份、HTTP/缓存容量和操作日志清理问题，并完成定向原生回归。控制端与网关已实际安装，二进制 SHA-256 与构建产物一致；Linux amd64 控制端交叉编译通过。2026-11-14 已用 playwright-cli 验收本机 HTTPS 永久入口启动 Example、双客户端 1920×1080 解码、唯一控制权授予/交接/撤销、断开隔离、停止后释放与恢复编辑，见[已安装版本验收](evidence/runtime-installed-3ae2c44d-20261114.json)。本次没有新增长跑、真人声学或 Android 验收，也未更新公开安装包。运行边界见[资源所有权](runtime-resources.md)。

| 内容 | 证据与边界 |
| --- | --- |
| 当前资源修复部署 | [3ae2c44d 已安装验收](evidence/runtime-installed-3ae2c44d-20261114.json)：严格本机 HTTPS、双 Web 端出画面、唯一控制与麦克风权限交接、断开后另端持续解码、停止后活动会话/连接为零；不等于实际音频、原生输入或新 LAN 地址媒体重验 |
| 当前管理端布局 | [a616beba 布局与交互](evidence/management-layout-a616beba.json)：已安装 8 路由、390/1440px，设置额外覆盖 320/1023/1024/1920px；独立原生后端含 820px 平板。无整页横向溢出，无页面异常或已安装页面 HTTP 错误；不代表媒体链路重验 |
| 精确服务端安装包 | [统一安装器](evidence/unified-installers-3d4a3b5c.json)：Windows 实际静默安装、自启动配置、服务恢复、音频端点、卸载；Linux 原始产品页面操作；不等于整机重启 |
| 本机管理端与 Web | [本机真实 LAN 操作](evidence/management-overview-local-windows-3d4a3b5c.json)：双端解码、授予/交接/撤权、停止与参数保存恢复；当时地址为旧 LAN IP |
| 同源 Linux 管理 / Web | [Linux 实际页面](evidence/management-overview-linux-3d4a3b5c.json)：双观看端、统一状态、控制权和参数操作；不代表 Linux 真机性能 |
| Android 与 Web 联合运行 | [联合检查](evidence/android-joint-windows-571295af-20261110.json)：APK .6、控制端 `571295af`、官方 Windows 模拟器，覆盖控制交接、声音、麦克风到原生端点及观看端、断网和前后台 |
| Android 程序音及录音 | [Windows 音频](evidence/android-release-audio-windows-20261110.json)、[生命周期](evidence/android-release-lifecycle-windows-20261110.json)、[焦点](evidence/android-release-focus-windows-20261110.json)：各自旧部署版本和模拟器环境，不外推真机声学质量 |
| Android 实际目标输入 | [输入六阶段](evidence/android-stream-input-3d4f248c-20261110.json)：APK .6 与 `3d4f248c` 服务端；不等于本机最新版本输入重验 |
| 真人语音与稳定性 | [既有真人语音](evidence/human-voice-installed-20261105.json)按原版本保留；20 客户端四小时稳定性已接受，无需重复 24 小时 |
| 独立地址恢复 | [独立 Linux 网卡实验](evidence/lan-address-recovery-20261107.json)：可信名称解析与真实 WebRTC 恢复，不代替本机 Windows 实验 |

## 当前生产结论与源码修复

**尚不能宣布整个产品生产就绪或 7×24 无 OOM 风险。** 核心串流能力已有实际证据，但当前源码、本机组件与公开下载包尚未合并为同一交付基线；旧版验收不覆盖全部新修复。

2026-11-14 [广度及资源生命周期复审](evidence/production-readiness-review-20261114.json)新增确认三处缺陷，均已在源码 `472d3f68` 修复并定向验证，**尚未构建部署或发布**：

| 风险 | 修复和验证 |
| --- | --- |
| 合法观看连接可发送无大小上限的心跳 JSON，部分管理命令也缺少统一预算 | 全 API 控制体 1 MiB；原生 HTTP 已复现旧版接受 4 MiB 固定长度/chunked 心跳，新版拒绝且会话不变；2 MiB TAR 实际上传、提取仍通过 |
| 应用操作锁表永久保留历史 ID | 仅保留活动操作，按所有者删除；旧版 20,000 次操作保留 20,000 条，新版归零；100 个争用者及旧释放不能解锁新操作 |
| Web Canvas 视频换轨/关闭未取消持锁 reader | 使用 reader 取消与 finally 释放、关闭迟到帧；真实 Chrome 20 次换轨/关闭释放 20/20，无 pageerror；这不是已安装串流版本的验收 |

本机仍为上表的 `3ae2c44d` 组件；最新公开服务端仍为 `20261110.5` preview。不能把源码已提交写成客户已经收到修复。

后续实现统一了全部控制 JSON 接口的容量错误、单文档解析和既有字段校验；分块超限也返回 413，会话表单解析失败不再使用部分字段。真实 Go HTTP / SQLite 检查通过。Chrome 原生换轨/关闭扩大到 100/100，并覆盖无帧、初始化关闭、并发初始化、源结束和原生绘制异常；MSE/WebCodecs 原生验收通过。历史 CI 的 Rust 格式问题已纠正，绕过 MSE 构造函数的失真用例由真实浏览器检查替换并纳入 CI。以上仍为源码验证，未改变本机或公开安装包身份。

## 尚未闭合的生产交付与验收

首轮候选 `997ea9998540371511364085fad36c2040498ce0` 的服务端构建 `43591809087` 已取消：关联 CI 暴露了 Rust 严格 lint 和原生浏览器验收任务缺少协议生成依赖的问题。缓存分支已等价整理，原生测试断言已补具体错误信息，浏览器验收移至网关生成协议之后；本机严格 Clippy 与原生浏览器检查通过。签名 Android 候选任务 `43591813789` 成功（版本 0.1.0 / versionCode 1000014），但属于撤回的来源组合，尚未发布或安装；不将其与后续服务端候选混用。后续验收脚本可独立更新，但不能修改候选产物或其来源身份。

Android 输入/音频验收必须显式指定 `product_run_id`，并在 `android_run_id` 与 `android_release_tag` 中二选一。候选模式要求服务端与 APK 来源相同，复用签名原始字节并验证 APK 内嵌来源、签名及 SBOM；地址迁移验收也必须显式指定产品任务，不回退旧预发布。

当前候选冻结在 `ce52bdace58abb4dc13dc3eec4727daa6549a88f`，版本 `0.1.0`；统一产品任务 `43595814290` 的 Linux 安装包已成功，Windows 仍在构建；签名 Android 任务 `43595818809` 已成功，versionCode `1000014`。本地已核对 Linux 安装包 SHA-256 `c1252aa7effd77953ffe9abf200c5fd36d2fc057596eccfbd37f95f586c6277d`、APK SHA-256 `9d6dd691cba611b00f658b1bc0c6cf474b5a2e434a3b3a3e0e358312c975f740` 与各自产物清单一致；这不是安装或音频通过记录。前一候选 `db01e6c639612f5796b0055c1885d4fa512686ff` 的 Linux 包及 APK 成功，但 Windows 产品任务 `43592679124` 缺少静态 Qt Core 的 Libb2 依赖，不能发布完整产品。已明确安装官方 UCRT64 Libb2 并在编解码库编译前检查；两个候选之间没有修改产品运行代码。之后的验收工具修改不改变冻结产物身份。人工完整运行时维护入口及回退边界见[部署维护](../deploy/README.md)，尚未用此工具更新本机。

`db01e6c6` 的[地址迁移](evidence/lan-address-recovery-db01e6c6-20261114.json)已通过：独立测试网卡换 IP、HTTPS/发现及 WebRTC 恢复，组件不重启、证书和身份保持；不代表共享 Windows 主机或 Android 实际地址迁移。[Android/Web 输入六阶段](evidence/android-input-db01e6c6-20261114.json)也已通过，包含首次授权、交接、撤权和再次授权。初次输入失败的验收工具没有确认自身打开的工具栏已收起；补齐真实 UI 状态确认后使用同一 APK/服务端通过，未改产品输入权限。

候选音频任务 `43593967541` 在官方 API 36 模拟器的独立系统音对照阶段失败，未进入产品。新同源候选的 API 35 任务 `43596786945` 在音量校准失败：旧 shell setter 确认后 14 次独立回读仍为 5/15，未进入产品。AOSP `VolumeCtrl` 传入内部服务包名，音频服务还会校验调用身份；不能把 shell 确认当成音量已生效。独立 testOnly 工具改用自身包身份调用公开 `AudioManager.setStreamVolume`，声明普通 `MODIFY_AUDIO_SETTINGS` 权限，限定模拟器，随后仍由只读 shell 独立确认。任务 `43597503785` 已实际确认从 5/15 变为 15/15，但随后因要求 Android 16 才有的音频权限控制器启动日志而拒绝 API 35。现按 AOSP 版本分别检查：API 36 保留原控制器要求，API 35 明确该项不适用并确认其实际音频服务创建；两者继续要求真实系统音与产品音频通过。不会修改 AppOps、系统安全策略、产品 APK 或音频门槛；仍未获得新候选完整音频通过结果。已终止的 Windows 构建不可继续作为新验收输入，不放宽来源校验。

旧 Android `.6` 的独立诊断任务 `43592967203` 已确认公共系统音输出对照通过；随后实际产品仍在 Android 程序音阶段失败（Web 约 −30.13 dB，Android 997 Hz 中位振幅约 `1.15e-7`，门槛 `0.01`）。Android 接收计数、解码能量和 AudioFlinger 轨道在增长，实际 PulseAudio 输出接近静音；尚不足以定位具体故障层。未进入麦克风及撤权音频判定，不能算整体通过，也不能把外层浏览器验收错误误写为产品尚未启动。该诊断使用旧产物，不代替上述新候选验收。

- 将当前源码修复纳入完整统一安装包，完成精确产物的安装/核心媒体验收并发布，更新本机组件；保持应用、观看密钥、CA 和运行数据。
- 当前共享宿主机实际整机重启、登录后无人手工补启动的完整恢复流程仍未验收。
- 本机新 LAN IP 的管理与网关入口已恢复；同一永久入口在新地址的完整视频、音频、输入及 Android 联合恢复仍需独立 Example 验证。没有改网卡模拟迁移，也没有重装客户端 CA。
- Android .6 在 Linux 模拟器环境的[近静音负例](evidence/android-stream-audio-df7cd87b-20261109.json)尚未解释。Windows 结果不改写该失败，不向生产 App 加入探针。
- 物理设备的扬声器、耳机、输入法和特定 UE 内部录音按各自证据范围判断；本轮不要求 Linux 或手机真机验收。
- 7×24 是设计可靠性要求；按当前发布决策，修复及候选产物定向验收通过后先正式发布，168 小时运行观察留作后续跟踪，不再列为首版发布阻塞。尚无新版本服务端、Web 和 Android 的 168 小时证据，不能宣称通过；既有四小时结果不改写。

Windows 通用自动原位升级、数据库自动降级以及一台渲染主机多应用并行隔离未提供，属于明确能力边界，不能混同已经确认的泄漏缺陷。自动升级与自动降级不作为首版原有核心功能的新增强制条件；需要多应用并行时则必须另行完成相应执行与采集隔离能力。当前源码复审也不替代独立安全评估、全依赖漏洞审计或其他未执行的验收。

当前地址更新是配置操作：加入新 TLS 身份，核对显式公开地址/来源/ICE 配置，重启服务。不存在任意 DHCP 地址变化都会自动更新数字 IP 证书或书签的保证。具体操作见[地址与证书](lan-address-configuration.md)。
