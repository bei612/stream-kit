# Stream-Kit

Stream-Kit 将管理服务、Sunshine 渲染端和 Moonlight Web 媒体网关集成为一个源码仓库，通过浏览器观看和控制云端应用。管理端只有一个管理员；观看客户端通过会话链接加入，由管理员分配唯一控制权。

服务端支持 Windows/Linux，客户端提供 Web/PWA 和 Android 原生 App。手机和平板也可直接使用浏览器；浏览器采集麦克风需要安全上下文和用户授权。当前发布渠道为预发布，不能把构建成功视为全部生产验收完成。

基于官方 Moonlight Android 源码二开的 [Android 签名 APK 20261109.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-android-preview.20261109.2) 已发布，使用原项目签名覆盖安装到实体平板与官方模拟器。本版保留可收起工具栏、键盘、鼠标/触屏模式和设置，补充常显“控制者 / 仅观看”身份、权限提示与服务器地址修改入口。平板、模拟器和 Web 同时接入 Example，依次交接及释放控制权，两端原生身份显示正确，见[三端实际检查记录](docs/evidence/android-exclusive-control-20261109.json)和[操作说明](docs/android-viewer-controls.md)。这些结果不代表 Windows 目标程序输入及物理麦克风全链路已完成新验收。

本机管理服务与网关仍安装源码 `47c02726`；可信 LAN HTTPS 已部署。新源码已包含原 CA 下配置式服务证书更新、当前/历史会话分离、7 天/100 条历史上限，以及管理端与 Web 权限界面调整；统一安装包正在构建，尚未部署这些服务端改动。不能以源码页面预览代替真实页面验收。地址配置与验证边界见[局域网地址配置](docs/lan-address-configuration.md)，剩余交付范围见[当前 Goal](docs/goal-current.md)。

应用与会话生命周期现已按权威原生执行实例同步，真实准入凭据的到期时间保护启动过程，客户端心跳不会永久维持失败的 `starting`。这项修复仍待安装后的真实退出及恢复检查。2026-11-09 本机输入前置核查中，Windows 未授予独立 Example 窗口前台焦点，检查因而未发送串流按键；不能宣布目标输入验收通过，见[现场记录](docs/evidence/windows-owned-example-focus-20261109.json)。

## 安装与访问

2026-11-07 交付进展：HTTP/2 回环地址缺陷与首次安装缺少自动配对的问题均已修复。`928c012a` Linux 安装包从空网关目录打开永久链接即可自动配对并串流，随后真实切换测试网卡 IP，同一观看页面自动恢复画面与音频 RTP，见[首次启动与网络恢复证据](docs/evidence/managed-enrollment-20261107.json)。该候选的 Windows 安装验收发现音频设备要求重启时的处理缺陷，未予发布；`47c02726` 已修复安装顺序与退出码，精确安装包验收通过并已发布，见[安装流程修复记录](docs/evidence/windows-installer-restart-20261107.json)。本机部署尚未替换。

从 [GitHub Releases](https://github.com/bei612/stream-kit/releases) 获取当前可下载版本，查看该版本说明和 SHA-256。Windows 使用版本中的单个 `*-windows-amd64-setup.exe` 安装三个核心组件；无需另外安装官方 Sunshine 或 Moonlight Web，也不要再注册独立 Sunshine 服务。

当前统一安装预发布版为 [20261107.1](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261107.1)，提供源码 `47c02726` 构建的 Windows 单 EXE 和 Ubuntu 24.04 单文件安装包。本版包含自动主机配对、HTTP/2 地址修复及安装前音频端点准备，明确区分成功、失败和需要重启的退出码。Windows 已集成开源虚拟音频实现及签名控制器驱动。只安装三个运行组件及必需运行库，开发示例和验收工具均不随包交付；安装及运行无需宿主机另行安装 Node.js/npm。跨平台 CI、Linux 安装包初始化，以及 Windows 整包静默安装、自启动、原生音频、网关与系统服务重启、卸载检查已通过。本版 Windows 验收包含服务重启，不是整机重启。7 个公开附件的大小、SHA-256 与验收产物一致，见[发布核验](docs/evidence/unified-installers-47c02726.json)和[安装说明](deploy/releases/0.1.0-preview.20261107.1.md)。发布不会自动替换已有部署，也不代表已完成本机 HTTPS 切换及实际 IP 变化恢复验收。

Windows 安装器支持向导和静默模式。以管理员终端执行，将文件名替换为实际下载的名称：

```powershell
.\stream-kit-preview-902798f02d6e-windows-amd64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

默认程序目录为 `C:\Program Files\StreamKit`，运行数据目录为 `C:\ProgramData\StreamKit`。静默模式自动生成独立管理员密码，管理员可从受保护的 `orchestrator.json` 中读取 `server.username` 与 `server.password`。自动化部署也可以通过 `/ADMINFILE` 提供凭据文件；密码不作为命令行参数传入。

Ubuntu 24.04 amd64 使用同一版本中的 `.run` 文件，明确指定实际拥有桌面和音频会话的非 root 用户：

```sh
sudo bash stream-kit-preview-902798f02d6e-ubuntu24.04-amd64-setup.run --user RENDER_USER
```

数据位于该用户的 `~/.local/share/stream-kit/runtime`，管理员凭据同样保存在受保护的 `orchestrator.json` 中。没有桌面会话时可加 `--no-start`，登录桌面后再启动用户服务。系统运行库由 apt 安装；详细说明见 [Linux 部署说明](deploy/linux/README.md)。

| 入口 | 初始地址 | 用途 |
| --- | --- | --- |
| 统一管理端 | `http://127.0.0.1:9000` | 配置组件、应用、会话、连接、控制权和音频 |
| Web 媒体网关 | `http://127.0.0.1:8080` | 浏览器会话媒体传输 |
| Sunshine 管理接口 | `https://127.0.0.1:47990` | 由统一管理端配置与调用 |

已有开发服务占用默认端口时，安装命令可以追加 `/CONTROLPORT=19000 /GATEWAYPORT=18080 /RENDERERPORT=48989`，三个组件的地址、健康检查和浏览器来源随之一起配置。初始监听仅限本机；远程使用需在管理页配置访问地址、HTTPS 和媒体网络。

Windows 安装初始化检查各组件文件清单、版本及端口。服务启动命令等待控制端和自动启动的媒体组件就绪。已有程序目录、数据目录或其他 SCM 部署不会被覆盖；目前不支持 Windows 安装器原位升级。卸载移除匹配的服务和程序文件，保留运行数据。

安装包当前未使用发行者证书签名，商业代码签名证书不作为本次交付要求；附带内核驱动已完成签名校验。本版 Windows 静默安装、管理员登录、LocalSystem 自动服务启动、音频端点、服务重启和卸载已在隔离 Windows Server 2022 中通过，且验收散列与公开下载文件一致，见 [整包安装证据](docs/evidence/unified-installers-902798f0.json)。服务重启检查不等于整机重启验收。产品不依赖 VB-CABLE。详细参数、会话身份和部署边界见 [Windows 安装说明](deploy/windows/README.md)。

## 使用流程

1. 登录统一管理页面，检查渲染端与媒体网关状态，完成主机配对。
2. 添加服务器已有程序路径，或上传压缩包并选择入口程序。
3. 为应用配置启动参数、指定程序/桌面画面、声音来源及输入策略。
4. 在应用详情启用并复制固定观看链接，无需先启动串流；客户端打开链接即可按保存的参数启动应用。链接长期有效，可由管理员轮换使旧链接失效。在管理页查看连接并授予、转移或释放唯一控制权。
5. 需要麦克风时，配置目标节点与音频端点。当前控制者在浏览器或 Android App 主动开启采集；旁观者、已撤权连接不能发送有效输入或麦克风。广播音频同时包含程序音及已授权客户端麦克风。

服务器将浏览器麦克风送入通用录音机或 UE5 时，需要一个实际可用的虚拟输出/录音端点对；客户端仍使用自身的物理麦克风和扬声器。端点由管理页选择，不限定 VB-CABLE 品牌，不要求客户购买 VB-CABLE。新开源实现已完成本机驱动安装、原生 PCM 收发，以及 [新网关到 UE5 的五阶段授权链路](docs/evidence/browser-native-audio-ue5-20261101.json)：未授权拒绝、控制者送音、旧控制者拒绝、新控制者送音、释放后拒绝，并保持旁观端混音广播。该次链路不使用 VB-CABLE。

设备标识采用公开允许共享的 Audio 类 `16c0:27e0` 与发布方邮箱前缀，无需申请 USB 编号。安装器为每台部署生成独立且持久的序列号。该标识已通过 Windows 系统音频类驱动的实际 PCM 和端点重启检查，详见 [共享音频身份记录](docs/evidence/windows-shared-audio-identity-20261101.json)。当前预发布版已包含这项集成，并在媒体网关启动前准备输出策略；首次未准备的设备枚举可能短暂改变默认输出。本版整包安装、系统服务重启及默认音频设备保留已通过隔离 Windows 验收。2026-11-05 已有独立的 [本机真人讲话证据](docs/evidence/human-voice-installed-20261105.json)，其部署版本与 Android 模拟器合成音频证据分别记录，不混为同一验收。

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

## 验收与协议

已部署环境的管理端验收使用 `node scripts/accept-management-live.cjs --config PRIVATE.json --execute`，通过 `playwright-cli` 操作真实页面和 API，不替换网络响应。省略 `--execute` 只校验本地配置，不启动浏览器或应用。私有 JSON 配置需要填写 `base`（HTTPS 管理入口）、`ca_cert`（已有公开 CA 文件）、`auth_storage_state`（该入口管理员的 Playwright storage state）、`playwright_cli`（CLI 可执行文件）、`owned_example: true`、`example_app_id`、`expected_control_commit`（本机实际部署的完整 40 位提交）和 `output`（父目录已存在、目标尚不存在的新证据目录）。这些配置和证据放在被忽略的本地目录，不提交管理员凭据。

该脚本检查其他应用没有活动后，只操作明确指定的 Example；核对启动前固定链接、真实启动、两个独立观看连接的视频解码增长、管理页授予/交接/撤销控制权及观看端角色、停止和只读历史，并保存桌面/手机宽度截图及控制台结果。截图遮盖固定链接密钥，文本诊断脱敏。浏览器必须已信任原部署 CA；脚本不会忽略证书错误或安装信任。任何未达到的检查返回失败，不代表麦克风实声、原生 App 或目标程序输入已经验收。未通过生产实际部署运行前，该脚本本身不构成通过证据。

20 客户端四小时稳定性要求已按确认口径完成，不再补跑 24 小时。共享视频/程序音、唯一控制权、麦克风广播与撤权、录音端点回传等证据有各自范围，不能互相替代。

- [部署与验收记录](deploy/README.md)
- [架构与历史差距记录](docs/技术架构细节.md)
- [Windows 录音回传证据](contracts/audio-devices/windows-recording-20261031.json)
- [音频路由设计](contracts/audio-devices/routing-design.md)
- [媒体状态契约](contracts/media-state/README.md)

源码中的历史记录可能描述当时尚未接入的功能；当前行为应结合实际源码、构建清单和对应版本的运行证据判断。预发布说明中的未完成项应在完成实际验收后更新。

正式安装载荷仅包含三个运行组件和必需运行时。`example/`、[UE5 录音探针](example/ue5/README.md)、Playwright、测试脚本及测试配置属于开发验收，不进入客户安装器；两个平台的安装构建器共用规则并拒绝混入这些内容。示例可由开发者单独执行 `node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY` 构建。2026-11-01.3 及更早的历史预发布可能包含自检示例，其内容和验收边界保留在对应版本记录中。
