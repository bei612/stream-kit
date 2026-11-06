# Stream-Kit

Stream-Kit 将管理服务、Sunshine 渲染端和 Moonlight Web 媒体网关集成为一个源码仓库，通过浏览器观看和控制云端应用。管理端只有一个管理员；观看客户端通过会话链接加入，由管理员分配唯一控制权。

服务端支持 Windows/Linux，客户端采用 Web/PWA。手机和平板不需要安装原生客户端；浏览器采集麦克风需要安全上下文和用户授权。当前发布渠道为预发布，不能把构建成功视为全部生产验收完成。

2026-11-06 新增交付要求：在保留 Web/PWA 的基础上，纳入官方 Moonlight Android 源码二开，交付接入同一会话、控制权和音频链路的 Android 原生 APK。该 App 尚未交付，不能用现有 Web 检查代替 Android 验收；本机采用官方 Android Emulator 调试。完整范围和完成条件见 [当前 Goal](docs/goal-current.md)。

## 安装与访问

从 [GitHub Releases](https://github.com/bei612/stream-kit/releases) 获取当前可下载版本，查看该版本说明和 SHA-256。Windows 使用版本中的单个 `*-windows-amd64-setup.exe` 安装三个核心组件；无需另外安装官方 Sunshine 或 Moonlight Web，也不要再注册独立 Sunshine 服务。

当前统一安装候选版为 [0.1.0-rc.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-rc.2)，提供同一干净提交构建的 Windows 单 EXE 和 Ubuntu 24.04 单文件安装包。本版增加永久应用启动链接并修复局域网浏览器地址和原生观看页面资源路径。Windows 已集成开源虚拟音频实现及签名控制器驱动。只安装三个运行组件及必需运行库，开发示例和验收工具均不随包交付；安装及运行无需宿主机另行安装 Node.js/npm。六项跨平台 CI、Linux 安装包初始化、本机永久链接串流，以及新版 Windows 整包静默安装、原生音频、网关与系统服务重启、卸载检查已通过；真人讲话验收仍暂缓。文件清单和验证范围见 [本版交付状态](deploy/releases/0.1.0-rc.2.md)。

Windows 安装器支持向导和静默模式。以管理员终端执行，将文件名替换为实际下载的名称：

```powershell
.\stream-kit-0.1.0-66249387b329-windows-amd64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

默认程序目录为 `C:\Program Files\StreamKit`，运行数据目录为 `C:\ProgramData\StreamKit`。静默模式自动生成独立管理员密码，管理员可从受保护的 `orchestrator.json` 中读取 `server.username` 与 `server.password`。自动化部署也可以通过 `/ADMINFILE` 提供凭据文件；密码不作为命令行参数传入。

Ubuntu 24.04 amd64 使用同一版本中的 `.run` 文件，明确指定实际拥有桌面和音频会话的非 root 用户：

```sh
sudo bash stream-kit-0.1.0-509c94cf7d78-ubuntu24.04-amd64-setup.run --user RENDER_USER
```

数据位于该用户的 `~/.local/share/stream-kit/runtime`，管理员凭据同样保存在受保护的 `orchestrator.json` 中。没有桌面会话时可加 `--no-start`，登录桌面后再启动用户服务。系统运行库由 apt 安装；详细说明见 [Linux 部署说明](deploy/linux/README.md)。

| 入口 | 初始地址 | 用途 |
| --- | --- | --- |
| 统一管理端 | `http://127.0.0.1:9000` | 配置组件、应用、会话、连接、控制权和音频 |
| Web 媒体网关 | `http://127.0.0.1:8080` | 浏览器会话媒体传输 |
| Sunshine 管理接口 | `https://127.0.0.1:47990` | 由统一管理端配置与调用 |

已有开发服务占用默认端口时，安装命令可以追加 `/CONTROLPORT=19000 /GATEWAYPORT=18080 /RENDERERPORT=48989`，三个组件的地址、健康检查和浏览器来源随之一起配置。初始监听仅限本机；远程使用需在管理页配置访问地址、HTTPS 和媒体网络。

Windows 安装初始化检查各组件文件清单、版本及端口。服务启动命令等待控制端和自动启动的媒体组件就绪。已有程序目录、数据目录或其他 SCM 部署不会被覆盖；目前不支持 Windows 安装器原位升级。卸载移除匹配的服务和程序文件，保留运行数据。

安装包当前未使用发行者证书签名，商业代码签名证书不作为本次交付要求；附带内核驱动已完成签名校验。Windows 静默安装、管理员登录、LocalSystem 服务启动和卸载已有历史真实记录，本候选版的鲜装与服务重启已在隔离 Windows Server 2022 中通过，见 [整包安装证据](docs/evidence/windows-installer-509c94cf.json)。SCM 双客户端串流的原自动化任务在最后的日志归档步骤失败，另已通过原生 Sunshine 日志和原始媒体指标补充核对核心功能，不能将原任务改写为通过。产品不依赖 VB-CABLE。详细参数、会话身份和部署边界见 [Windows 安装说明](deploy/windows/README.md)。

## 使用流程

1. 登录统一管理页面，检查渲染端与媒体网关状态，完成主机配对。
2. 添加服务器已有程序路径，或上传压缩包并选择入口程序。
3. 为应用配置指定程序/桌面画面、声音来源及输入策略，再创建会话。
4. 将会话观看链接交给客户端，在管理页查看连接并授予、转移或释放唯一控制权。
5. 需要麦克风时，配置目标节点与音频端点。当前控制者在浏览器主动开启采集；旁观者、已撤权连接不能发送有效输入或麦克风。广播音频同时包含程序音及已授权客户端麦克风。

服务器将浏览器麦克风送入通用录音机或 UE5 时，需要一个实际可用的虚拟输出/录音端点对；客户端仍使用自身的物理麦克风和扬声器。端点由管理页选择，不限定 VB-CABLE 品牌，不要求客户购买 VB-CABLE。新开源实现已完成本机驱动安装、原生 PCM 收发，以及 [新网关到 UE5 的五阶段授权链路](docs/evidence/browser-native-audio-ue5-20261101.json)：未授权拒绝、控制者送音、旧控制者拒绝、新控制者送音、释放后拒绝，并保持旁观端混音广播。该次链路不使用 VB-CABLE。

设备标识采用公开允许共享的 Audio 类 `16c0:27e0` 与发布方邮箱前缀，无需申请 USB 编号。安装器为每台部署生成独立且持久的序列号。该标识已通过 Windows 系统音频类驱动的实际 PCM 和端点重启检查，详见 [共享音频身份记录](docs/evidence/windows-shared-audio-identity-20261101.json)。当前候选版已包含这项集成，并在媒体网关启动前准备输出策略；首次未准备的设备枚举可能短暂改变默认输出。原生初始化、重复启动和默认输出保持检查已通过，本版整包安装与系统服务重启已通过隔离 Windows 验收；真人讲话验收仍待完成，生成测试音不替代物理麦克风讲话。

## 源码与构建

`third_party/` 包含直接纳管、经过二次开发的上游源码及必要依赖，不使用 submodule。原始版本、提交与许可证见 [upstream-lock.json](third_party-manifests/upstream-lock.json)。`docs/src/` 是历史参考资料，不是当前生产构建入口。

| 目录 | 职责 |
| --- | --- |
| `orchestrator/` | Go 管理服务、持久化、会话控制及 React 管理页面 |
| `third_party/moonlight-web-stream/` | Rust 媒体网关、共享上游、Web/PWA、音频混音与广播 |
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

20 客户端四小时稳定性要求已按确认口径完成，不再补跑 24 小时。共享视频/程序音、唯一控制权、麦克风广播与撤权、录音端点回传等证据有各自范围，不能互相替代。

- [部署与验收记录](deploy/README.md)
- [架构与历史差距记录](docs/技术架构细节.md)
- [Windows 录音回传证据](contracts/audio-devices/windows-recording-20261031.json)
- [音频路由设计](contracts/audio-devices/routing-design.md)
- [媒体状态契约](contracts/media-state/README.md)

源码中的历史记录可能描述当时尚未接入的功能；当前行为应结合实际源码、构建清单和对应版本的运行证据判断。预发布说明中的未完成项应在完成实际验收后更新。

正式安装载荷仅包含三个运行组件和必需运行时。`example/`、[UE5 录音探针](example/ue5/README.md)、Playwright、测试脚本及测试配置属于开发验收，不进入客户安装器；两个平台的安装构建器共用规则并拒绝混入这些内容。示例可由开发者单独执行 `node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY` 构建。2026-11-01.3 及更早的历史预发布可能包含自检示例，其内容和验收边界保留在对应版本记录中。
