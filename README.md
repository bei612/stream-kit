# Stream-Kit

Stream-Kit 将管理服务、Sunshine 渲染端和 Moonlight Web 媒体网关集成为一个源码仓库，通过浏览器观看和控制云端应用。管理端只有一个管理员；观看客户端通过会话链接加入，由管理员分配唯一控制权。

服务端支持 Windows/Linux，客户端采用 Web/PWA。手机和平板不需要安装原生客户端；浏览器采集麦克风需要安全上下文和用户授权。当前发布渠道为预发布，不能把构建成功视为全部生产验收完成。

## 安装与访问

从 [GitHub Releases](https://github.com/bei612/stream-kit/releases) 获取当前可下载版本，查看该版本说明和 SHA-256。版本中若提供 `stream-kit-preview-<COMMIT>-windows-amd64-setup.exe`，使用这一个安装器安装三个核心组件；无需另外安装官方 Sunshine 或 Moonlight Web，也不要再注册独立 Sunshine 服务。

Windows 安装器支持向导和静默模式。以管理员终端执行，将文件名替换为实际下载的名称：

```powershell
.\stream-kit-preview-COMMIT-windows-amd64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

默认程序目录为 `C:\Program Files\StreamKit`，运行数据目录为 `C:\ProgramData\StreamKit`。静默模式自动生成独立管理员密码，管理员可从受保护的 `orchestrator.json` 中读取 `server.username` 与 `server.password`。自动化部署也可以通过 `/ADMINFILE` 提供凭据文件；密码不作为命令行参数传入。

| 入口 | 初始地址 | 用途 |
| --- | --- | --- |
| 统一管理端 | `http://127.0.0.1:9000` | 配置组件、应用、会话、连接、控制权和音频 |
| Web 媒体网关 | `http://127.0.0.1:8080` | 浏览器会话媒体传输 |
| Sunshine 管理接口 | `https://127.0.0.1:47990` | 由统一管理端配置与调用 |

已有开发服务占用默认端口时，安装命令可以追加 `/CONTROLPORT=19000 /GATEWAYPORT=18080 /RENDERERPORT=48989`，三个组件的地址、健康检查和浏览器来源随之一起配置。初始监听仅限本机；远程使用需在管理页配置访问地址、HTTPS 和媒体网络。

安装初始化检查各组件文件清单、版本及端口。服务启动命令等待控制端和自动启动的媒体组件就绪。已有程序目录、数据目录或其他 SCM 部署不会被覆盖；目前不支持安装器原位升级。卸载移除匹配的服务和程序文件，保留运行数据。

安装包当前未签名，商业代码签名证书不作为本次交付要求。真实 SCM 跨会话串流、安装及卸载闭环验收尚未完成。构建流程已支持在取得分发授权后将虚拟音频驱动纳入同一个 EXE；当前已发布候选版仍未包含驱动。详细参数、会话身份和部署边界见 [Windows 安装说明](deploy/windows/README.md)。仍使用便携 ZIP 的版本请按随包说明部署。

## 使用流程

1. 登录统一管理页面，检查渲染端与媒体网关状态，完成主机配对。
2. 添加服务器已有程序路径，或上传压缩包并选择入口程序。
3. 为应用配置指定程序/桌面画面、声音来源及输入策略，再创建会话。
4. 将会话观看链接交给客户端，在管理页查看连接并授予、转移或释放唯一控制权。
5. 需要麦克风时，配置目标节点与音频端点。当前控制者在浏览器主动开启采集；旁观者、已撤权连接不能发送有效输入或麦克风。广播音频同时包含程序音及已授权客户端麦克风。

服务器将浏览器麦克风送入通用录音机或 UE5 时，需要一个实际可用的虚拟输出/录音端点对；客户端仍使用自身的物理麦克风和扬声器。端点由管理页选择，不限定 VB-CABLE 品牌。浏览器测试音到 Windows 虚拟端点的实录已有证据，物理麦克风和 UE5 的真实运行验收仍待完成。

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
node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY
node scripts/verify-sunshine-release.mjs SUNSHINE_BUILD_DIRECTORY FULL_COMMIT --output NEW_RENDERER_DIRECTORY
node scripts/package-platform-release.mjs CONTROL_BUNDLE GATEWAY_BUNDLE RENDERER_BUNDLE EXAMPLE_BUNDLE NEW_PLATFORM_DIRECTORY
node scripts/build-windows-installer.mjs PLATFORM_BUNDLE NEW_INSTALLER_DIRECTORY OFFICIAL_ISCC_EXE
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
