# 发布与部署基线

核对日期：2026-11-27。本页集中维护可下载版本、本机部署、候选产物和剩余边界。历史证据保留原始来源，不把旧版通过结果当作新产物验收。

当前发布候选冻结于 `ce49050f4dfcbd1e22d9d4f22093f6b965e6aac8`，含固定观看主机名与大型归档限额界面。[Windows 统一安装器](https://github.com/bei612/stream-kit/actions/runs/45939440963)已构建，大小 98,055,882 字节，SHA-256 为 `9ab0b300106e748fd21b62e5521c8dfe2c280cd252eed80d117844bc4f07fd8f`，原包与三组件清单均已核验。[Android 原生 APK](https://github.com/bei612/stream-kit/actions/runs/45939467986)的 versionCode 为 `1000024`，本地验证了 21 项文件和 v2/v3 发行签名，APK SHA-256 为 `f65455f6d07c7b66d14d86f51ed076cfea5e75a34c6693ede87697d996d6a0b7`。

同一 Windows 安装器在 [Windows Server 2022 CI](https://github.com/bei612/stream-kit/actions/runs/45943221270)通过静默安装、自启动配置、144,000 帧原生音频、网关和 SCM 服务恢复、卸载及数据保留。Win11 独立实例使用同包原生三组件验证了两个 Web 观众的应用画面和程序音，Example 正常停止。Playwright CLI 通过了同包管理页桌面和手机布局、上传限额、永久链接启用、轮换和关闭。[Android 与 Web 输入联验](https://github.com/bei612/stream-kit/actions/runs/45943466475)通过同源共享上游、触摸及按键交接、两类旧控制者撤权。证据和适用环境见[候选产物验收](evidence/windows-android-ce49050f-candidate-20261127.json)。本机更新的管理员启动命令被工具自动审批拒绝，现有 Windows 服务仍运行 `53c7385a`。

使用该源码的[隔离 Linux 安装器](https://github.com/bei612/stream-kit/actions/runs/45939312965)实际运行并通过[固定观看主机名换址验收](https://github.com/bei612/stream-kit/actions/runs/45941800647)。同一个浏览器页面和书签在换址后自动恢复画面与音频数据包，HTTPS 身份约 13.54 秒内更新，配置、CA 和私钥保持。换址前后各只有当时唯一的新旧 LAN 地址作为 UDP 主机候选。本机 Windows 和实体 Android 的联合现场换址继续使用独立证据。

本机已安装并验收的 `0.1.1` 候选源码为 `53c7385ac58d39408a3aaffef33d6a95ea06a737`。该源码包含归档上传空闲超时、直接落盘、媒体网关和解压依赖更新，以及 Go 1.27.4 工具链与 quic-go 补丁。Windows 11 原生 Go 定向测试通过，管理服务符号级扫描未发现已知漏洞。候选产物来自 [Windows 单安装器构建](https://github.com/bei612/stream-kit/actions/runs/45798220979)及 [Android 签名构建](https://github.com/bei612/stream-kit/actions/runs/45798220812)，Android versionCode 为 1000021。详见[工具链与依赖复核](evidence/windows11-runtime-dependency-review-53c7385a.json)。

上一候选 `324106b01312c722db82d922953d7588b0581a76` 首次将受管 WebRTC 会话的媒体 UDP 绑定到信令连接的实际 IPv4 地址，并包含应用详情语言修复。[Android APK](https://github.com/bei612/stream-kit/actions/runs/45933665875) 的 versionCode 为 `1000023`，本地核对了 21 项产物清单、APK 签名 v2/v3 和应用 ID，APK SHA-256 为 `fbc907d3ad317b7472b129a196e485348b5222a30b4f0fae8de2f8de0dc9dc8e`。[同源 Linux 安装器](https://github.com/bei612/stream-kit/actions/runs/45933396003)通过原生安装检查。[跨平台构建的 Windows 网关](https://github.com/bei612/stream-kit/actions/runs/45933396105/artifacts/15170067547)在本机通过 35 项文件核验及 30 项原生配置检查。[旧候选 Windows 安装器](https://github.com/bei612/stream-kit/actions/runs/45933668313)作为旧候选构建证据，本机部署仍运行 `53c7385a`。

Android 联验和隔离 LAN 换址验收可显式选择 Linux 安装器的构建工作流。两类验收直接消费固定构建的安装器并记录来源，Android 候选联验还会要求 APK 与安装器的源码提交完全相同。本候选已进入 [LAN 换址与媒体候选](https://github.com/bei612/stream-kit/actions/runs/45935146775)、[Android 与 Web 输入](https://github.com/bei612/stream-kit/actions/runs/45935149788)和 [Android 与 Web 音频](https://github.com/bei612/stream-kit/actions/runs/45935153698)实际联验。

候选的隔离 LAN 换址联验通过。两个 HTTPS 入口在 10.25 秒内更换服务证书，保留 CA 和私钥。原浏览器页面自动恢复串流，换址前后只收到当前直连地址的 UDP 主机候选。Android 与 Web 使用同一上游，双方实测轮流向目标交付按键及触摸，交接和撤权后的输入保持被拒绝。Linux 模拟器音频联验的独立系统音基线未通过。修复探针状态读取与 PCM 写入的争用后，已采到 194739 帧且探针丢帧为零，基准音仍近静音，产品音频测试未进入。见[音频探针修复后的联验](https://github.com/bei612/stream-kit/actions/runs/45936840917)。

Win11 独立实例以原生 HTTP 客户端及 Playwright CLI 驱动的 Chrome 分别上传并解压实际 26 GiB TAR，本地开发构建的页面操作和落盘已验收。随后以候选安装包原生管理服务再次接收 27,921,765,888 字节，实际解压 27,921,762,816 字节，应用进入就绪状态、Example 哈希一致、暂存及应用测试目录均已回收。候选包管理页已通过桌面和窄屏限额显示验收。正式装机的暂存与应用目录应按两项存储需求部署。[候选包大文件验收](evidence/windows-android-ce49050f-candidate-20261127.json) · [浏览器应用就绪截图](evidence/windows11-browser-upload-26gib-20261127.png)

同源签名 APK 的前后台恢复已在官方 Android 36 模拟器通过。Android 持有控制权时退出到桌面，服务释放该连接及控制权；回前台以全新观看连接恢复原串流，麦克风保持关闭。客户端恢复后观察到 300 个音频包和 115 帧解码画面，Web 继续共享同一渲染实例。[实际前后台联验](https://github.com/bei612/stream-kit/actions/runs/45948972310)

正式 Android `v0.1.0`（1000015）覆盖升级至当前签名候选（1000024）通过。升级后首次安装身份保留，从普通入口使用原书签即可入场，无需再次导入。客户端以观看者入场且麦克风保持关闭，随后通过实际输入和前后台恢复联验。[升级证据](evidence/android-upgrade-ce49050f-20261127.json) · [实际升级联验](https://github.com/bei612/stream-kit/actions/runs/45950069635)

官方 Android 36 模拟器断网联验通过。模拟器断网约 15.1 秒后控制权随租约过期，Web 同一渲染实例继续运行。恢复模拟器联网后，Android 原连接自行以观看者身份恢复，麦克风关闭，实际恢复 305 个音频包和 108 帧解码画面。该结果覆盖 Android 客户端断网重连，现场 Win11 宿主机换址需要独立联验。[实际断网恢复记录](https://github.com/bei612/stream-kit/actions/runs/45950890473)

同源 Android 音频已走到实际采集测量。原生页面开启麦克风，服务确认采集状态，工具向官方 AVD 接口提交了 253 个合成音包，同时观察 Web 与目标录音。目标分析 240,000 帧且零探针丢帧，但 1499 Hz 幅度未达标，Web 同期也低于门槛。独立系统播放基线同样未通过，尚需确认合成声源是否真正到达 Android 本地采集，以及发布候选的完整音频链路。此轮未执行到音频撤权测量。[同源音频原始结果](https://github.com/bei612/stream-kit/actions/runs/45950448625)

Linux 官方 Android Emulator `37.3.10` 的独立前台 AudioRecord 复核确认，合成注入 RPC 成功结束，探针录得完整 240,000 帧，系统未标记客户端静音，但 1499 Hz 在所有窗口中均未达到阈值，中位强度为 0。该轮同源产品音频判定保持失败，已经定位到模拟器本地声源验证失败，产品的麦克风回传仍需在可验证的输入环境补验。[独立采集基线](https://github.com/bei612/stream-kit/actions/runs/45952589388)

官方 Linux 模拟器 `37.2.13` 使用相同 Android 36 镜像和验收阈值，有一次通过独立系统播放基准，分析 192,000 帧并检出两组基准频率。加采录音进度后再次执行，系统播放未通过，录音在半程采样前停住。两次均未进入产品音频阶段，目前无法把差异归因于模拟器版本。[首次版本对照](https://github.com/bei612/stream-kit/actions/runs/45954552924) · [采集进度对照](https://github.com/bei612/stream-kit/actions/runs/45956151212)

本机旧部署的固定主机名 `volcengine.local` 已用同机 Playwright CLI 验证原 CA 下的管理入口、网关和 Example 永久链接，共解码 37 帧，随后正常停止 Example。记录只覆盖本机固定主机名入口。实体 Android 对该名字和换址后串流的现场确认另行记录。

本机 Windows 三个运行组件及实体平板已更新至候选 `53c7385a`，保持原应用、CA、配置与平板书签。单安装器、静默安装、服务自动恢复和卸载已经在 Windows Server 2022 CI 通过。实装 Win11 与平板、Web 的共享画面、程序音、控制权交接及平板麦克风至目标录音端点和 Web 观众均已验证。当前仍需独立 Win11 首装与实际回退、现场 LAN 换址、完整输入撤权验收和依赖剩余项处理。见[同源实装与联验](evidence/windows11-android-joint-53c7385a.json)、[安装器验收](https://github.com/bei612/stream-kit/actions/runs/45806470686)。

2026-11-27 已实测 `53c7385a` 整机重启。控制服务在开机后 14.42 秒启动，Sunshine 和媒体网关随桌面会话在约 31 秒启动，均未手工启动。WLAN 由 `192.168.0.119` 变为 `192.168.2.131`，管理与媒体 HTTPS 在原 CA 下通过。原永久链接只换主机地址即可唤起 Example，同机浏览器实际选用了隧道候选。两个普通 Web 客户端的真实键盘交接和撤权通过，观察到两位控制者依次使目标计数增加，转交后及撤权后计数均保持。实体平板在新 WLAN 上对主机的邻居解析失败，跨机媒体待验收。见[Win11 重启与实际换址](evidence/windows11-reboot-and-lan-53c7385a-20261127.json)。

初始候选 `1fa79664` 的 Windows 11 隔离管理页已通过 ZIP、7z 和本机路径登记；最终安装候选的管理子包已在 Win11 隔离页面复核 7z。签名覆盖升级和书签校验保留各自实测版本。见[初始候选验收](evidence/windows11-android-candidate-1fa79664.json)、[签名候选平板覆盖安装](evidence/windows11-android-tablet-upgrade-53c7385a.json)。

候选冻结后，源码 `e55bd5ec` 修正应用详情的固定观看链接和采集能力状态中英文混用。Windows 隔离页面验收已覆盖两种语言与链接启用、重置、关闭。该页面修复待随下一个完整同源安装包部署。见[应用详情语言核验](evidence/app-detail-localization-e55bd5ec.json)。

实体 Android 平板的目标输入缺口现已补齐：[实际输入与控制交接验收](evidence/android-input-tablet-954a1e6e-20261126.json)使用已安装的 `954a1e6e` 原生 APK、同源 Windows 服务和 Playwright CLI 管理页。Example 实际按键/点击计数在平板授权后由 5/6 增至 6/7；移交给 Web、交回 Android 和释放控制后，旧控制端的输入均未改变目标计数。原加密书签完整恢复，临时工具已卸载，Example 停止且无活动测试会话。本次不修改生产源码、不重新构建或安装；整机重启、首次安装返回 3010 后的重启路径及本机主网卡真实换址仍未完成验收。

源码 `954a1e6e` 新增共用概念气泡的视口避让和生命周期修复：原安装版手机宽度 390px 时隐藏气泡撑至 639px，已在实际安装页面复现。新同源产物现已完整安装；Playwright CLI 对实际安装页面的 8 路由 × 3 宽度及中英文气泡检查通过，四张截图已目视复核。键盘、触屏、配置冲突和组件启停另有同源 CI 证据。详见[已安装验收](evidence/runtime-installed-954a1e6e-20261120.json)和[修复审查](evidence/management-tooltip-review-20261119.json)。运行依赖审查发现一个 React Router 告警包；[逐公告适用性核查](evidence/management-dependency-review-20261119.json)未发现当前调用方式暴露所列攻击路径，包仍未升级，不声明扫描清零。

历史 Win11 维护 `954a1e6e73ef95231e78c9d77d77d932749aa043` 保留本轮回退副本，三组件库存已验证。该版本的管理端资源为 `index-DkDzwuSd.js` / `index-BQYlHHxO.css`。当时服务为 Auto / LocalSystem / Running，两个子组件均 running、崩溃计数 0，原配置、信任和应用身份保留。见[954a1e6e 安装与页面验收](evidence/runtime-installed-954a1e6e-20261120.json)。

已公开的最新预发布运行源码冻结为 `954a1e6e73ef95231e78c9d77d77d932749aa043`，沿用局域网地址自动识别、双入口证书热更新及 OpenSSL 4.1 兼容，并修复概念气泡布局。[v0.1.0-preview.20261119.3](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.3) 已公开 Windows/Linux 安装器、Android APK 及配套材料。首次部署该预发布时，本机三组件与平板同源。14 个附件的字节数和 GitHub 存储摘要已与已验证产物核对，其中 Windows 安装器及六份材料完成匿名全量下载。其余大文件复用先前构建附件校验。详见[发布证据](evidence/release-preview-20261119.3.json)。历史维护失败、回滚和重启要求分别保留原始记录。

自动换址已通过[真实隔离网络验证](evidence/lan-autodiscovery-515b9918-20261119.json)：移除旧 IP 并新增 IP 后，6.93 秒内两个 HTTPS 入口更新身份，CA、私钥、配置与进程保持，WebRTC 自动恢复到新媒体地址。该实验实际运行 `515b9918`；其管理端和网关源码与 `1d81a373` 完全一致，记录仍保留原始运行身份。本页下方手动地址恢复记录证明的是更新前的本机状态。

## 当前版本

| 对象 | 版本 / 来源 | 状态 |
| --- | --- | --- |
| 公开 Windows / Ubuntu 24.04 amd64 服务端 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2e933fb597e97dec999cceae9a3e614e1` | 11 月 15 日正式版，每平台一个安装器；不含本次自动换址功能 |
| 公开签名 Android | [v0.1.0 同一 Release](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，同源 `f8ede8b2`，versionCode 1000015 | 已公开 APK、来源、校验和、依赖许可证和 SBOM，沿用持久发行签名 |
| 本机运行组件及前端 | `53c7385ac58d39408a3aaffef33d6a95ea06a737` | 三组件及管理前端完整维护，保留原安装器、卸载器和签名驱动。库存、共享流、程序音及平板麦克风通过 [现场验收](evidence/windows11-android-joint-53c7385a.json) |
| 最新公开预发布服务端 / Android | [v0.1.0-preview.20261119.3](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.3)，`954a1e6e` | Windows / Ubuntu 24.04 amd64 单文件安装器及持久签名 APK 已发布，14 个附件校验通过；尚未替代正式 0.1.0 |
| 本机平板 Android | 0.1.1 候选 / versionCode 1000021，`53c7385a` | [签名与覆盖安装](evidence/windows11-android-tablet-upgrade-53c7385a.json)及[同源视频、程序音、按键和麦克风联验](evidence/windows11-android-joint-53c7385a.json)通过。上一版完整输入证据见[954a1e6e 原始实测](evidence/android-input-tablet-954a1e6e-20261126.json) |
| 上一版实体平板媒体验收 | 0.1.0-preview.20261119.2 / versionCode 1000017，`1d81a373` | [真机会话验收](evidence/android-tablet-1d81a373-20261119.json)及[真机音频补验](evidence/android-tablet-audio-1d81a373-20261119.json)：实际视频、共享会话/控制、录音生命周期、程序音接收、物理麦克风至服务器端点和 Web 观众及撤权静音通过；目标键鼠输入仍未通过，不称真机全部通过；未重复未受影响的媒体验收 |
| 历史同源 Android 联合实测 | 0.1.0 / versionCode 1000015，`f8ede8b2` | [构建来源](https://github.com/bei612/stream-kit/actions/runs/43609422069)，专用模拟器实际图像、程序音、麦克风及撤权通过；不冒称新 APK 的媒体复验 |

正式 0.1.0 已发布，当前核心功能达到本页所列产物与环境的发布条件；整个 Goal 仍有下文的整机重启和真实地址迁移等验收边界。发布复用[原始产品构建](https://github.com/bei612/stream-kit/actions/runs/43609416420)的字节，经[发布任务](https://github.com/bei612/stream-kit/actions/runs/43613696666)校验并上传；tag 指向冻结运行源码，文档及验收器后续提交不改变产物身份。

## 本机 Windows

| 项目 | 当前值 |
| --- | --- |
| 服务 | `StreamKitOrchestrator`，自动启动，LocalSystem |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时 LAN 入口 | `https://192.168.0.119:9000/login` |
| 网关 / 渲染端内部端口 | HTTPS 8080 / 原生 48989、管理 48990 |

完整运行维护已统一替换三个组件及其前端，保留原安装器、卸载器、签名驱动和运行数据；不等同于在本机重新执行新安装器。当前 LAN IP 已从固定身份配置移除，由新运行时自动发现并纳入证书；原 CA 保持，9000/8080 实际 HTTPS 均通过。管理员凭据和观看密钥不写入文档或日志。

2026-11-19 本次实际开机时间 17:16:32，人工维护前查到控制服务 17:16:47、网关 17:16:48、Sunshine 17:16:49 已启动，健康接口全部 running、崩溃计数为 0。此次访问失败原因是 WLAN 地址已由 `192.168.3.27` 改为 `192.168.0.119`，新 IP 不在原证书中。已备份受保护配置及证书，将新 IP 加入 `server.lan_tls.hosts`，通过两个组件原生配置检查并重启归属服务；原 CA、CA 私钥、服务私钥和应用记录保持。管理端及网关新 IP 的 TLS 校验通过，Playwright CLI 实际登录页和截图通过。无活动应用被中断，未启动 UE 或执行新媒体串流验收。见[开机与地址恢复证据](evidence/windows-boot-address-20261119.json)及[登录页面截图](evidence/windows-boot-address-20261119.png)。

Sunshine 即使使用外部配置，仍要求程序旁存在空 `config` 目录。首次安装会建立它，维护器现在也在管理员暂存阶段建立，并拒绝覆盖非空本地状态；不放宽 Program Files 权限。原失败及回滚、原生复现和后续成功分别保留，见[已安装验收](evidence/runtime-installed-ce52bdac-20261114.json)及[部署维护](../deploy/README.md)。

LAN IP 是现场值，不是内置地址。本机新版已在已有 CA、通配监听和自动识别启用下验证当前私有 IP 的身份生成；其他仍运行旧版的部署需按实际地址维护 TLS 配置。显式公开地址/来源/ICE 覆盖仍由管理员管理，具体见[地址与证书](lan-address-configuration.md)。保留部署 CA 和观看密钥，数字 IP 书签不会自动改写；当前地址自动发现不等于真实主网卡迁移，服务重启也不等于整机重启验收。

## 修复与验收

| 内容 | 证据与范围 |
| --- | --- |
| 最新实体平板目标输入 | [954a1e6e 输入补验](evidence/android-input-tablet-954a1e6e-20261126.json)：实际原生平板与 Web 共用一个 Example 上游，平板按键及触屏点击到达目标窗口；Playwright CLI 在已安装管理页完成双向移交和释放，旧控制端输入无效。九张实际截图已复核；原书签恢复、临时工具卸载、会话停止。使用 ADB 生成设备输入事件，不代表真人触屏操作或本轮音频复验 |
| Android 实体平板定向验收 | [1d81a373 真机记录](evidence/android-tablet-1d81a373-20261119.json)：原生永久入口启动 Example，初始实际解码 90 帧，Android 与 Web 共用一上游；管理页转交控制后平板变旁观者并停止录音。切后台释放 Android 连接，Web 保持；回前台重新解码、以旁观者加入且未自动录音。原加密书签恢复摘要一致，两个 testOnly 辅助 APK 已卸载，全部测试会话已停止。目标输入失败/音频未验收和辅助工具失败如实保留 |
| Android 实体平板音频补验 | [同源真机音频](evidence/android-tablet-audio-1d81a373-20261119.json)：临时显式配置现有项目虚拟端点，程序音使 Android 解码累计能量升至 0.0807；实际平板麦克风到服务器录音端点的最大 RMS 由 0.0000154 升至 0.00497，撤权后为 0.0000156；Web 观众最大 RMS 为 0 → 0.0435 → 0。未要求讲话、不保存 PCM，不代表声学音质或语音可懂度验收；网关少量丢帧和客户端补偿样本保留。Example 参数、会话路由、原书签均恢复，辅助工具卸载，零活动测试会话 |
| 本机最新同源运行与页面 | [954a1e6e 已安装验收](evidence/runtime-installed-954a1e6e-20261120.json)：完整三组件库存与服务恢复、配置和信任保留、双管理入口可信 HTTPS、8 路由 × 3 宽度和中英文气泡通过，4 张截图目视通过，页面异常为 0。此前 [1d81a373 媒体与操作检查](evidence/runtime-installed-1d81a373-20261119.json)保留永久链接启动 Example、双 Web 控制交接、停止后编辑与退出等证据；本次未重跑媒体或启动 UE |
| 自动识别地址与双入口热更新 | [真实隔离迁移](evidence/lan-autodiscovery-515b9918-20261119.json)：新 IP 的原 CA 校验、旧 SAN 移除、三进程/配置/私钥保持及 WebRTC 新地址恢复通过；首次脚本权限失败及修复单独保留，不等同于本机 Windows/Android 真机迁移 |
| 服务端持续资源上限与释放 | [资源审查](evidence/runtime-resource-review-20261113.json)：帧元数据、握手失败连接、媒体队列、缓存、HTTP 响应和日志清理，已纳入本机及候选；资源所有权见[运行资源](runtime-resources.md) |
| 控制请求和操作锁 | [生产复审](evidence/production-readiness-review-20261114.json)：控制体统一 1 MiB，固定长度/chunked 超限返回 413，上传保留独立预算；锁仅保留活动所有者，20,000 次完成后归零 |
| 浏览器帧生命周期 | Canvas reader 取消、finally 释放、迟到帧关闭；原生 Chrome 100 次换轨/关闭及异常分支通过，MSE/WebCodecs 原生检查通过，已纳入本机和候选 |
| 本机实际 UI / 循环 | [ce52bdac 验收](evidence/runtime-installed-ce52bdac-20261114.json)：严格 HTTPS、永久入口启动 Example、双端 1920×1080、唯一控制授予/交接/撤销、断开隔离、停止后可编辑；100 次真实进入/解码/工具栏退出，各批恢复单连接，无页面异常 |
| 默认 H.264 混合连接 | ce52 Web 先入声明 High 4:4:4，Android 后入被拒。f8ede8b2 将两端默认统一为普通 H.264 掩码 0x0001，高阶格式仍可显式选择实验性 auto；[新本机联合回归](evidence/runtime-installed-f8ede8b2-20261115.json)证明 Web 先启动、Android 后加入，同一会话持续解码，实际 H.264 profile-level-id=64001f |
| 精确 Windows 安装器 | [f8ede8b2 安装验收](evidence/windows-installer-f8ede8b2-20261114.json)：原始字节静默安装、自启动、网关恢复、SCM 重启、144000 帧原生录音、卸载及数据保留通过；不代替本机维护或整机重启 |
| 实际资源观察 | [ce52bdac 原始计数](evidence/runtime-resources-ce52bdac-20261114.json)：45.64 分钟混合负载采样未含 SCM 主服务；补充 14.51 分钟已预热单观看端完整采样，主服务 64.63→64.28 MiB、网关 19.99→20.00 MiB、浏览器进程合计 566.26→581.92 MiB，句柄未持续累积。为部署已就绪的新包提前结束窗口；不标成计划时长完成，不推断长期无泄漏 |
| 正式 0.1.0 Linux 实际页面 | [f8ede8b2 页面验收](evidence/management-live-f8ede8b2-20261114.json)：原始统一包、可信 HTTPS、真实双 WebRTC 解码、唯一控制交接、参数保存恢复及桌面/手机截图；不含 Android 音频或长跑 |
| Windows Android / Web 音频 | [ce52 音频验收](evidence/android-audio-windows-ce52bdac-20261114.json)：Android 程序音 239999 帧 / 49 窗口，Web 程序音、合成麦克风到真实录音端点和观众、撤权静音通过。采用 Android 先入，仅证明音频链路；参数、路由、音量均恢复，无保存 PCM |
| 新本机同源联合验收 | [f8ede8b2 实际运行](evidence/runtime-installed-f8ede8b2-20261115.json)：Web 先入；Android 程序音 49/49 窗口、Web 程序音通过，Android 合成麦克风到原生录音端点及 Web 观众，撤权后两端静音、零采集丢帧；停止后零活动会话/连接/媒体观测。测试参数、路由和音量恢复，模拟器已停止，服务 Auto/LocalSystem/Running |
| 原生输入和独立地址恢复 | [输入六阶段](evidence/android-input-db01e6c6-20261114.json)、[独立 Linux 网卡迁移](evidence/lan-address-recovery-db01e6c6-20261114.json)保留实际来源，不代替本机 Windows 主网卡或新 APK 验收 |
| 管理端统一布局 | [布局与交互](evidence/management-layout-a616beba.json)：8 路由共用容器/栅格/导航，覆盖手机、平板、桌面、草稿保留与冲突；新候选实际页面另见上行，维护契约见[管理布局](management-layout.md) |

检查使用独立 Example、外部采样器和专用模拟器，不进入生产安装包或 APK。不启动或修改其他代理维护的 UE，不修改 ToDesk、宿主机默认音频或客户端信任来绕过问题。

## 交付结果

最新预发布 [v0.1.0-preview.20261119.3](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.3) 通过[原产物发布任务](https://github.com/bei612/stream-kit/actions/runs/44569208733)公开，未重新编译。Windows 安装器为 `stream-kit-preview-954a1e6e73ef-windows-amd64-setup.exe`，98,019,654 字节，SHA-256 `5b5bf5a5f8795fa5b524aefaf773cf395faff61128fbe58cfd8e8e8486e80e01`；已完成公开匿名下载并与[实际安装验收](evidence/windows-installer-954a1e6e-20261120.json)逐字节身份核对。该独立环境中原生录音捕获 144,000 帧，零丢帧/缓冲异常、网关及自动服务恢复、卸载及数据保留通过。此前环境返回 `3010` 的结果仍保留，不代表该环境已完成重启后验收。Android 为持久签名 versionCode 1000018；Linux 安装器来源及初始化边界见[Linux 产物证据](evidence/linux-installer-954a1e6e-20261120.json)。完整附件及下载核对范围见[发布证据](evidence/release-preview-20261119.3.json)。

上一预发布 [v0.1.0-preview.20261119.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.2) 的 14 个附件全量下载、旧本机同源维护及其网络失败记录保留在[历史发布证据](evidence/release-preview-20261119.2.json)及上方原始验收中，不作为最新安装状态。

正式 0.1.0 的 Windows/Linux 安装器、Android APK、源码 tag、校验和及许可证材料已发布；其本机完整组件维护与联合回归保留原始证据。资源采样已收齐，不重复未受影响的四小时或 100 次循环。原完整跨平台 CI 六项已通过；一次 Ubuntu 任务因官方 Chrome 下载的 HTTP/2 中断重试，只重跑失败任务，未重建原冻结产品。公开附件与实际下载核验见[0.1.0 发布证据](evidence/release-0.1.0-20261115.json)。

已公开的上一预发布 Windows 安装器为 `stream-kit-preview-1d81a373ac29-windows-amd64-setup.exe`，97,995,563 字节，SHA-256 `568a2cd5736582a721f26a00a329e40909e4123327b1432b07b8d4669579a562`。[同一字节安装验收](evidence/windows-installer-1d81a373-20261119.json)已通过：安装/卸载退出码 0、真实 PCM 144,480 帧且零丢帧/缓冲异常、网关与 Auto / LocalSystem 服务重启恢复、默认设备和数据保留均通过。未重新构建产物。

此前[首次全新安装](https://github.com/bei612/stream-kit/actions/runs/44517278501)安装成功但返回原生驱动要求重启的 `3010`，其 PCM 和服务生命周期检查未执行；卸载和数据保留通过。该真实结果保留，后一次成功不代表所有 Windows 环境首次装驱动都无需重启。验收器补充了有界 PnP/SetupAPI 诊断，保持原通过门槛；本机维护保留已有驱动，与全新驱动安装是不同路径。

## 持续边界

- 冻结源码 `954a1e6e` 的跨平台六项、Windows/Linux 产品构建、同字节 Windows 独立安装验收、本机完整维护与页面验收均通过，已发布 `20261119.3`。首次安装的 [3010 重启要求](evidence/windows-installer-restart-954a1e6e-20261120.json)保留，尚无该次环境的重启后验证；后一次无需重启环境的成功不覆盖它。旧运行的语言选择和依赖源失败保留原记录。依赖安装报告 19 项告警（含开发依赖），运行依赖适用性见上方逐公告审查，不能声明全依赖安全审计完成。
- 当前 `53c7385a` 已验证实际 Win11 整机重启和三个组件自行恢复。首次安装返回 3010 的环境仍保留独立验收边界。
- 本机新 LAN 管理入口、自动当前 IP 身份和真实 Web 视频已通过；真实主网卡迁移后的 Windows/Android 完整媒体及输入恢复尚未验收。独立 Linux 实验不覆盖此环境。
- 平板真实目标输入已由 [11 月 26 日补验](evidence/android-input-tablet-954a1e6e-20261126.json)闭合；程序音、物理麦克风至目标端点/Web 观众及撤权静音保留 11 月 19 日证据。本次 Windows 未锁屏，最初激活辅助工具选择的窗口中心被 `mstsc` 遮挡；只对经 HWND 归属验证的 Example 可见区域执行普通点击后，平板按键与触屏输入实际到达目标。没有改动其他远程控制程序或绕过输入保护。此前 `LockApp` 是宿主机当时的观察，不是平板锁屏，也不能作为所有焦点失败的原因。原生权限标记在控制变更后曾短暂滞后，服务端已拒绝旧端输入；本次没有测量亚秒级界面更新或录音停止延迟。历史失败、零音量和旧模拟器记录保留原环境边界。
- [Linux 模拟器音频负例](evidence/android-audio-fixture-ce52bdac-20261114.json)保留；旧 APK 在该环境的近静音未解释。Windows 通过不改写其他环境的失败，也不降低采集门槛。
- 用户已接受原版本 20 客户端四小时稳定性，不重复 24 小时；真人语音保留[原始证据](evidence/human-voice-installed-20261105.json)。本轮不要求 Linux/手机真机、特定 UE 内部录音或物理设备声学验收。
- 7×24 是设计目标，目前没有新版本服务端、Web、Android 的完整 168 小时证据，不能承诺永不 OOM。修复和精确产物定向验收通过后先发布，长期运行继续跟踪；不靠定时重启或强制 GC 替代释放。
- 一台渲染主机当前同时运行一个应用串流，可供多个客户端观看；不提供多应用并行隔离。Windows 通用自动原位升级、数据库自动降级、全依赖漏洞审计及独立安全评估不在已通过范围。
