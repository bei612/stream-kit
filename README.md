# Stream-Kit

Stream-Kit 将管理服务、Sunshine 渲染端和 Moonlight Web 媒体网关集成为一个源码仓库，通过浏览器观看和控制云端应用。管理端只有一个管理员；观看客户端通过会话链接加入，由管理员分配唯一控制权。

服务端支持 Windows/Linux，客户端提供 Web/PWA 和 Android 原生 App。手机和平板也可直接使用浏览器；浏览器采集麦克风需要安全上下文和用户授权。当前发布渠道为预发布，不能把构建成功视为全部生产验收完成。

基于官方 Moonlight Android 源码二开的 [Android 签名 APK 20261109.6](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-android-preview.20261109.6) 已发布，版本码 `1000013`、源码 `df7cd87b`，沿用项目持久签名。本版区分连接租约过期和连接终止，已终止连接立即关闭本地权限、麦克风及媒体并停止恢复；陈旧操作不能影响替代连接。签名 release 构建、唯一持久签名、源码身份、封装及五个公开附件校验已通过；本次未重跑此前的 19 项 JVM 检查，也未声明新版本音频或完整生命周期验收通过。精确版本见[发布记录](docs/evidence/android-release-20261109-6.json)。

同源运行 `42651317973` 已实际进入上述 APK：普通模拟器音量基准由 5 调至 15 并读回成功，Web 程序音正常，但 Android 专属输出的实际 PCM 及独立双声道 `parec` 均近零，尚未进入麦克风/撤权声学阶段，见[精确失败记录](docs/evidence/android-stream-audio-df7cd87b-20261109.json)。收包、累计能量和播放设备状态不等于扬声器已输出声音；公共模拟器音频出口当时没有独立阳性对照，不能据此定位产品或测试出口哪一侧有误。新 APK 对本机旧服务的[终态兼容观察](docs/evidence/android-legacy-terminal-20261110.json)另行保留：真实出画面、停止后终态及短时无重新入场已观测，原脚本因 SDK 日志证据不足仍为失败，不代表活跃麦克风释放或新服务端协议通过。

此前 `1000012` / `4cd50f91` 在创建播放设备前接入同一份媒体配置，明确使用当前支持的 48 kHz 双声道内容输出；系统仍可按实际设备重采样，麦克风配置保持独立。该 APK 的实际验收 `42637432848`、`42643666290` 均在 CI 模拟器音量基准检查失败，尚未进入 App；后者保留了 13 次实际音量仍为 5 的观测。后续 `42648498466` 复用同一 APK，在音量命令能力探测失败，同样未进入 App、没有声学结果；不是 `1000013` 的实际验收。见[该版本记录](docs/evidence/android-release-20261109-5.json)。

此前 `1000010` / `c8e677c6` 在真实模拟器验收中已进入观看，但 Android 实际播放仍接近静音；`42631879793` 使用标准 `parec` 独立采集双声道得到相同近零结果，未发现左右相消，不能把问题仅归因于 CPAL 单声道观测。旧版原始指标和边界见[历史诊断](docs/evidence/android-release-20261109-4.json)，不替代本次 `1000012` 的实际验收。

客户端保留可收起工具栏、键盘、鼠标/触屏模式、设置、控制者身份及服务器地址修改入口，见[操作说明](docs/android-viewer-controls.md)。此前 `20261109.2` 已覆盖安装到实体平板和官方模拟器，并与 Web 同时接入 Example，交接及释放控制权时身份显示正确，见[三端实际检查记录](docs/evidence/android-exclusive-control-20261109.json)。这些旧版结果不替代后续 APK 的实际设备、输入或音频验收，也不代表本机 Windows 目标程序及物理麦克风全链路已验收。

本机管理服务与网关现为源码 `98e419f7`，Sunshine 渲染端保留 `47c02726`；系统服务为 `Running` / `Auto`，应用 ID 和原 LAN CA 保留，见[本机两组件维护记录](docs/evidence/local-control-gateway-maintenance-98e419f7.json)。最新 Windows/Linux 统一安装包为源码 `92818fba` 的 [20261110.1](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261110.1)，见[安装与发布证据](docs/evidence/unified-installers-92818fba.json)。该版本已通过独立 Linux 实际部署的 [playwright-cli 操作及截图验收](docs/evidence/management-live-cli-92818fba.json)；本机完整控制端与网关仅完成维护预检，尚未应用，不能将独立部署结果写成本机通过。Android APK 仍为上文的独立签名版本。地址配置与边界见[局域网地址配置](docs/lan-address-configuration.md)，剩余范围见[当前 Goal](docs/goal-current.md)。

2026-11-09 的 `20261109.2` APK 实际输入验收已通过：该 APK 与源码 `98e419f7` 的 Linux 安装包共用一个程序渲染会话，原生目标的按键/点击计数确认 Android 控制、Web 接管、旧控制者拒绝、撤权拒绝及重新授权均正确，最后目标实例停止得到确认。见[精确版本和六阶段结果](docs/evidence/android-stream-input-20261109.json)。本轮没有重复音频或长稳测试，也不代表本机 Windows 或后续 APK 输入验收通过。

应用与会话生命周期现已按权威原生执行实例同步，真实准入凭据的到期时间保护启动过程，客户端心跳不会永久维持失败的 `starting`。`98e419f7` 已在独立 Linux 环境通过两个 Web 观看端保持连接时目标窗口正常退出的真实检查：约 4.8 秒内终结旧会话并撤权，旧凭据在到期前被拒绝，见[被动退出证据](docs/evidence/native-session-exit-20261109.json)。本次没有出现替代实例，不代表该分支、故障恢复或本机部署通过。2026-11-09 本机输入前置核查中，Windows 未授予独立 Example 窗口前台焦点，检查因而未发送串流按键；不能宣布目标输入验收通过，见[现场记录](docs/evidence/windows-owned-example-focus-20261109.json)。

## 安装与访问

保留的历史验证：`928c012a` Linux 安装包从空网关目录打开永久链接即可自动配对并串流，随后真实切换测试网卡 IP，同一观看页面自动恢复画面与音频 RTP，见[首次启动与网络恢复证据](docs/evidence/managed-enrollment-20261107.json)。`47c02726` 修复了后续 Windows 安装验收发现的音频设备重启处理、安装顺序与退出码，见[安装流程修复记录](docs/evidence/windows-installer-restart-20261107.json)。当前发布和本机安装状态以上文为准；不将历史网络切换记录改写为新版本重新验收。

从 [GitHub Releases](https://github.com/bei612/stream-kit/releases) 获取当前可下载版本，查看该版本说明和 SHA-256。Windows 使用版本中的单个 `*-windows-amd64-setup.exe` 安装三个核心组件；无需另外安装官方 Sunshine 或 Moonlight Web，也不要再注册独立 Sunshine 服务。

当前统一安装预发布版为 [20261110.1](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261110.1)，提供源码 `92818fba` 构建的 Windows 单 EXE 和 Ubuntu 24.04 单文件安装包，修复浏览器媒体 HTTP 响应生命周期，保留明确的连接终态处理。Windows 已集成开源虚拟音频实现及签名控制器驱动。只安装三个运行组件及必需运行库，开发示例和验收工具均不随包交付；安装及运行无需宿主机另行安装 Node.js/npm。Linux 初始化、Windows 静默安装与服务/音频/卸载检查，以及独立 Linux 真实页面操作已分别通过。Windows 重启检查不包含整机重启，空默认音频基线不能外推到已有非空设备设置。7 个公开附件的大小、服务端 SHA-256 与已核验构建产物一致，见[精确安装与发布证据](docs/evidence/unified-installers-92818fba.json)和[安装说明](deploy/releases/0.1.0-preview.20261110.1.md)。此前版本的记录保留原范围。发布不会自动替换已有部署，也不代表本机 Windows、Android 音频或实际宿主机 IP 切换通过。

Windows 安装器支持向导和静默模式。以管理员终端执行，将文件名替换为实际下载的名称：

```powershell
.\stream-kit-preview-92818fba2e09-windows-amd64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

默认程序目录为 `C:\Program Files\StreamKit`，运行数据目录为 `C:\ProgramData\StreamKit`。静默模式自动生成独立管理员密码，管理员可从受保护的 `orchestrator.json` 中读取 `server.username` 与 `server.password`。自动化部署也可以通过 `/ADMINFILE` 提供凭据文件；密码不作为命令行参数传入。

Ubuntu 24.04 amd64 使用同一版本中的 `.run` 文件，明确指定实际拥有桌面和音频会话的非 root 用户：

```sh
sudo bash stream-kit-preview-92818fba2e09-ubuntu24.04-amd64-setup.run --user RENDER_USER
```

数据位于该用户的 `~/.local/share/stream-kit/runtime`，管理员凭据同样保存在受保护的 `orchestrator.json` 中。没有桌面会话时可加 `--no-start`，登录桌面后再启动用户服务。系统运行库由 apt 安装；详细说明见 [Linux 部署说明](deploy/linux/README.md)。

| 入口 | 初始地址 | 用途 |
| --- | --- | --- |
| 统一管理端 | `http://127.0.0.1:9000` | 配置组件、应用、会话、连接、控制权和音频 |
| Web 媒体网关 | `http://127.0.0.1:8080` | 浏览器会话媒体传输 |
| Sunshine 管理接口 | `https://127.0.0.1:47990` | 由统一管理端配置与调用 |

已有开发服务占用默认端口时，安装命令可以追加 `/CONTROLPORT=19000 /GATEWAYPORT=18080 /RENDERERPORT=48989`，三个组件的地址、健康检查和浏览器来源随之一起配置。初始监听仅限本机；远程使用需在管理页配置访问地址、HTTPS 和媒体网络。

Windows 安装初始化检查各组件文件清单、版本及端口。服务启动命令等待控制端和自动启动的媒体组件就绪。已有程序目录、数据目录或其他 SCM 部署不会被覆盖；目前不支持 Windows 安装器原位升级。卸载移除匹配的服务和程序文件，保留运行数据。

安装包当前未使用发行者证书签名，商业代码签名证书不作为本次交付要求；附带内核驱动已完成签名校验。`6546792a` Windows 静默安装、管理员登录、LocalSystem 自动服务启动、音频端点、服务重启和卸载已在隔离 Windows Server 2022 中通过，且验收散列与公开下载文件一致，见[本版整包安装证据](docs/evidence/unified-installers-6546792a.json)。服务重启检查不等于整机重启验收；卸载保留检查确认配置文件存在，未独立覆盖应用文件和数据库保留场景。产品不依赖 VB-CABLE。详细参数、会话身份和部署边界见 [Windows 安装说明](deploy/windows/README.md)。

## 使用流程

1. 登录统一管理页面，检查渲染端与媒体网关状态，完成主机配对。
2. 添加服务器已有程序路径，或上传压缩包并选择入口程序。
3. 为应用配置启动参数、指定程序/桌面画面、声音来源及输入策略。
4. 在应用详情启用并复制固定观看链接，无需先启动串流；客户端打开链接即可按保存的参数启动应用。链接长期有效，可由管理员轮换使旧链接失效。在管理页查看连接并授予、转移或释放唯一控制权。
5. 需要麦克风时，配置目标节点与音频端点。当前控制者在浏览器或 Android App 主动开启采集；旁观者、已撤权连接不能发送有效输入或麦克风。广播音频同时包含程序音及已授权客户端麦克风。

服务器将浏览器麦克风送入通用录音机或 UE5 时，需要一个实际可用的虚拟输出/录音端点对；客户端仍使用自身的物理麦克风和扬声器。端点由管理页选择，不限定 VB-CABLE 品牌，不要求客户购买 VB-CABLE。新开源实现已完成本机驱动安装、原生 PCM 收发，以及 [新网关到 UE5 的五阶段授权链路](docs/evidence/browser-native-audio-ue5-20261101.json)：未授权拒绝、控制者送音、旧控制者拒绝、新控制者送音、释放后拒绝，并保持旁观端混音广播。该次链路不使用 VB-CABLE。

设备标识采用公开允许共享的 Audio 类 `16c0:27e0` 与发布方邮箱前缀，无需申请 USB 编号。安装器为每台部署生成独立且持久的序列号。该标识已通过 Windows 系统音频类驱动的实际 PCM 和端点重启检查，详见 [共享音频身份记录](docs/evidence/windows-shared-audio-identity-20261101.json)。当前预发布版已包含这项集成，并在媒体网关启动前准备输出策略；首次未准备的设备枚举可能短暂改变默认输出。`6546792a` 的隔离 Windows 验收安装前没有默认音频端点，卸载后恢复为空；本次结果不能证明已有非空默认设备选择保持不变，具体范围见[本版记录](docs/evidence/unified-installers-6546792a.json)。2026-11-05 已有独立的 [本机真人讲话证据](docs/evidence/human-voice-installed-20261105.json)，其部署版本与 Android 模拟器合成音频证据分别记录，不混为同一验收。

## 源码与构建

`third_party/` 包含直接纳管、经过二次开发的上游源码及必要依赖，不使用 submodule。原始版本、提交与许可证见 [upstream-lock.json](third_party-manifests/upstream-lock.json)。`docs/src/` 是历史参考资料，不是当前生产构建入口。

| 目录 | 职责 |
| --- | --- |
| `orchestrator/` | Go 管理服务、持久化、会话控制及 React 管理页面 |
| `third_party/moonlight-web-stream/` | Rust 媒体网关、共享上游、Web/PWA、音频混音与广播 |
| `third_party/moonlight-android/` | 官方 Android 客户端二开、原生媒体、统一会话与输入 |
| `third_party/sunshine/` | 指定应用/桌面捕获、编码及输入处理 |
| `components/audio-target/` | 服务器音频目标与原生录音探针 |
| `example/` | 棋盘、交互、声音播放及麦克风接收测试程序 |
| `contracts/` | 控制面、媒体、设备与配置协议 |
| `scripts/` | 源码构建、整包校验及定向验收入口 |
| `deploy/` | 安装器、服务定义和部署说明 |

使用锁定工具链与依赖。Windows 在本机原生环境构建，Sunshine 使用原生 MSYS2 UCRT64 工具链；Linux 构建由独立 Linux 环境和 CI 执行。不要以下载的旧版官方二进制替代本仓库修改后的源码产物。

```text
node scripts/build-control-plane.mjs --require-clean --output NEW_CONTROL_DIRECTORY
node scripts/build-gateway-release.mjs --output NEW_GATEWAY_DIRECTORY
node scripts/verify-sunshine-release.mjs SUNSHINE_BUILD_DIRECTORY FULL_COMMIT --output NEW_RENDERER_DIRECTORY
node scripts/package-platform-release.mjs CONTROL_BUNDLE GATEWAY_BUNDLE RENDERER_BUNDLE NEW_PLATFORM_DIRECTORY
node scripts/build-windows-installer.mjs PLATFORM_BUNDLE NEW_INSTALLER_DIRECTORY OFFICIAL_ISCC_EXE --usb-audio-driver deploy/windows/usb-audio-driver --signtool OFFICIAL_WINDOWS_SDK_SIGNTOOL_EXE --usb-audio-identity deploy/windows/usb-audio-identity.json
```

Sunshine 原生编译入口见 [build-sunshine.sh](scripts/build-sunshine.sh)。安装器使用官方 Inno Setup 7.1.1。以上发布步骤校验干净工作树、同一源码提交及文件完整性，各输出目录必须是新目录。测试、运行凭据、数据库和构建产物保留在被忽略的本地目录。

独立 Android 输入/音频验收通过显式选择产品构建和已发布 APK 复用原始运行产物；被动原生退出验收只复用产品运行时，不下载 APK。仅修改这些独立验收脚本、观察工具或来源校验器时，不自动触发跨平台运行时构建；Linux 产品工作流也排除其明确列出的专用辅助文件。生产源码、打包入口和其依赖模块继续触发原有构建检查，手动产品构建及同一源码提交的整包校验规则保持有效。

## 验收与协议

`test-media-access.mjs`、`test-viewer-authority.mjs`、`test-viewer-bootstrap.mjs`、`test-webrtc-lifecycle.mjs` 和 `test-stream-pipelines.mjs` 使用 VM、替代请求或替代媒体对象，现仅作为历史 fixture 归档，已退出必需 Node 门禁；其中旧的隐式 resume/续票假设不代表当前协议，绕过真实构造器的输入、统计与媒体替身也不代表实际播放和停止生命周期，均不计为通过。Go 真实处理器与 SQLite 持久化回归保留，覆盖 `CONNECTION_LEASE_EXPIRED`、`CONNECTION_TERMINATED` 的区分、恢复和显式撤销，并检查重新加载存储后的分类；原生构建、生产 SPA 和 Chromium/Firefox/WebKit 真实浏览器检查继续保留。新版原生运行时及实际安装环境的 `playwright-cli` 完整流程正在推进，必须核对该次实际运行组件与源码身份；未部署、未实际运行通过的项目仍未验收，旧 `98e419f7` 运行时的历史结果不替代新协议源码验证，CI 编译成功也不等于生产交付通过。

被动原生退出的独立入口为 [native-exit-acceptance](.github/workflows/native-exit.yml)。手动选择已有产品运行时构建和完整源码提交；默认复用 `42599646248` / `98e419f7f85fa36a92651ee55396815386a233c4`，核对 GitHub 运行归属、成功的 Linux job、安装清单、安装文件和载荷 SHA-256，以及提取后的组件文件清单。工作流只编译验收用 X11 目标，在独立 Linux 环境建立真实 Sunshine、网关、控制端和两个 Web 观看端；不重建产品、不下载 Android、不复测音频/输入/长稳。

该场景先确认目标 PID、可执行文件、窗口归属及原生 InstanceID 与运行中的会话一致，再通过真实 `WM_DELETE_WINDOW` 请求目标自行退出。旧代次必须在不调用停止接口的情况下终结、清空连接和控制者、退出签名媒体授权，并在自然到期前拒绝旧邀请、连接凭据和媒体票据。若观看端自动重连实际创建了新原生实例，还会按 InstanceID 检查旧代次撤销不会误杀该实例；若没有创建替代实例，只证明本次旧代次终结和撤权，不代表已覆盖替代实例或中断恢复矩阵。最终清理由共用生命周期完成，只操作本次目标。新增脚本与语法检查不构成通过证据，结论以该工作流的实际运行结果为准。

管理端应用和组件共用 `useResourceCommand` 命令边界，`useAppCommand` 保留应用命令的类型封装。同一资源的命令从同步点击到操作后刷新完成持续互斥，不同资源可分别操作；组件页按资源显示进行中及真实失败，刷新失败也保留提示。启动应用的任务仍在浏览器点击事件内同步调用，避免抽象破坏弹窗打开时机。工作台仅展示组件概览并直达组件管理页，启停操作集中在组件管理页。

源码侧隔离管理验收入口为 `node scripts/accept-management-native.cjs --binary REAL_ORCHESTRATOR --dist PRODUCTION_DIST --output NEW_DIRECTORY`，默认配置不启动任何编码器或网关。追加 `--component-commands` 后，脚本在独立临时配置、SQLite 和端口中，将同一个真实 Orchestrator 程序作为受管组件启动、重启及停止，并使用实际不存在的程序路径验证失败反馈；同帧重复点击必须各只产生一次启停请求，停止态运行时长显示为 `-`，同一错误只显示一份。原来的空组件、配置版本冲突及桌面/手机布局检查继续保留。该模式不替换 React、HTTP 响应或进程实现，结束时停止并清理自己创建的进程和临时目录；CI 保留默认跨浏览器检查，并额外执行一次 Chromium 组件命令检查。本机已用真实 `98e419f7` 控制程序验证这一范围；这不代表生产安装、自启动、应用弹窗、原生 App 或媒体链路验收通过，最终部署仍需独立 live 检查。历史 `test-app-command.mjs` 的 fake React/VM 检查仅归档保留，已退出当前验收门槛。

新版 Android 音频回归入口为 `android-stream-audio-acceptance` 工作流，显式选择已完成的产品构建和已发布 APK；默认选择同源运行时构建 `42648530658` 与 APK `v0.1.0-android-preview.20261109.6`。独立 testOnly 系统音阳性对照必须在产品 App 入场前确认公共模拟器输出可用；它不替代程序音、麦克风或撤权指标，失败也不能记作产品 App 音频失败。它在独立 GitHub Linux 环境复用真实 Sunshine/网关/管理服务、官方 Android 模拟器及可信 HTTPS，通过官方 `injectAudio` 注入输入声源，用同一个原生 `audio-probe` 分别录取 Android 实际播放端和服务器麦克风目标，并结合真实 Web 观看端核对程序音、麦克风广播及持续注入期间的撤权。Android 专属播放端要求在 6.5 秒内收到至少 192000 个 48 kHz 帧（至少 4 秒），997 Hz 的 100 ms 窗口振幅中位数必须大于 0.01；保存实际帧数、窗口数、采样率、起止时间及端点进程归属。Web 程序音与原生播放端录音并行，统一使用后续麦克风验收继续复用的持续观测图：5 秒内连续 3 个真实样本高于 -65 dB，随后至少 2 秒的样本中位数仍须高于 -65 dB，并保存各时刻的 RTP、解码采样数与 AudioContext 时钟；不再依赖另外一次短时前置采样。默认 AEC/NS/AGC 保持开启，不替换 `getUserMedia`，只保留 PCM 数量和频谱指标，不保存声音；结果必须以该次实际工作流输出为准。此项与输入验收分开，不代表实体设备、真人语音质量或本机部署已验收。

音频工作流在独立 Xvfb 中运行官方完整模拟器，不使用 `-no-window`：公开的 AOSP [启动器源码](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emulator/main-emulator.cpp)将该选项映射到 headless 程序，而 [构建配置](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/CMakeLists.txt)为 Linux headless 版本链接 [PulseAudio 空实现](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/audio/paaudio-headless-impl.c)。这份公开源码属于 35.6 分支，不能直接代表实际 SDK 37.2 的精确构建；验收另外核对实际 `/proc` 启动进程及子进程的完整程序路径，要求该进程的所有真实 PulseAudio 输出仅进入 Android 专属 sink，并拒绝其他进程在该 sink 输出。`PULSE_SINK` 只覆盖模拟器启动命令；浏览器使用独立 host sink，程序音和麦克风目标分别使用另外两个 sink。后端缺失或归属错误直接失败，无输出 API 兜底，不延长 PCM 或麦克风起声时限。这些模拟器、虚拟显示及声源工具仅用于验收，不进入客户安装包。

历史音频验收运行 `42609829166`、`42611515890`、`42613634402` 因 SDK `streamAudio` 返回的 PCM 数量不足而失败，均未计为通过；最后一次已核实完整模拟器和真实 PulseAudio 后端正常，但该 RPC 仍仅返回约 42 kB，不能将问题归因于 headless，也不宣称已修复 SDK。正式观测现统一采用 Android 真实 PulseAudio 播放端，不再调用该输出 RPC；产品传输链路和原信号门槛保持不变，新的端点验收仍须实际运行通过。

已部署环境的管理端验收使用 `node scripts/accept-management-live.cjs --config PRIVATE.json --execute`，通过 `playwright-cli` 操作真实页面和 API，不替换网络响应。省略 `--execute` 只校验本地配置，不启动浏览器或应用。私有 JSON 配置需要填写 `base`（HTTPS 管理入口）、`ca_cert`（已有公开 CA 文件）、`auth_storage_state`（该入口管理员的 Playwright storage state）、`playwright_cli`（CLI 可执行文件）、`owned_example: true`、`example_app_id`、`expected_control_commit`（本机实际部署的完整 40 位提交）和 `output`（父目录已存在、目标尚不存在的新证据目录）。这些配置和证据放在被忽略的本地目录，不提交管理员凭据。

该脚本检查其他应用没有活动后，只操作明确指定的 Example；核对启动前固定链接、真实启动、两个独立观看连接的视频解码增长、管理页授予/交接/撤销控制权及观看端角色、停止和只读历史，并保存桌面/手机宽度截图及控制台结果。停止后还通过应用详情页实际修改、保存有效的 Example 参数并恢复原参数，核对 API 与编辑器一致；失败时按真实应用和会话状态安全恢复，遇外部配置变化拒绝覆盖并记录失败。原参数只留内存，参数文本框及固定链接密钥在截图中遮盖，文本诊断脱敏。浏览器必须已信任原部署 CA；脚本不会忽略证书错误或安装信任。任何未达到的检查返回失败，不代表麦克风实声、原生 App 或目标程序输入已经验收。未通过生产实际部署运行前，该脚本本身不构成通过证据。

20 客户端四小时稳定性要求已按确认口径完成，不再补跑 24 小时。共享视频/程序音、唯一控制权、麦克风广播与撤权、录音端点回传等证据有各自范围，不能互相替代。

- [部署与验收记录](deploy/README.md)
- [架构与历史差距记录](docs/技术架构细节.md)
- [Windows 录音回传证据](contracts/audio-devices/windows-recording-20261031.json)
- [音频路由设计](contracts/audio-devices/routing-design.md)
- [媒体状态契约](contracts/media-state/README.md)

源码中的历史记录可能描述当时尚未接入的功能；当前行为应结合实际源码、构建清单和对应版本的运行证据判断。预发布说明中的未完成项应在完成实际验收后更新。

正式安装载荷仅包含三个运行组件和必需运行时。`example/`、[UE5 录音探针](example/ue5/README.md)、Playwright、测试脚本及测试配置属于开发验收，不进入客户安装器；两个平台的安装构建器共用规则并拒绝混入这些内容。示例可由开发者单独执行 `node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY` 构建。2026-11-01.3 及更早的历史预发布可能包含自检示例，其内容和验收边界保留在对应版本记录中。
