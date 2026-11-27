# 发布与部署基线

核对日期 2026-11-28。这里记录可下载版本、现场安装及验收范围。安装、配网和维护操作分别见 [Windows 安装](../deploy/windows/README.md)、[地址与证书](lan-address-configuration.md)和[部署运维](../deploy/README.md)。

## 当前版本

| 对象 | 版本 | 对应交付 |
| --- | --- | --- |
| 公开正式版 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2` | Windows 和 Ubuntu 24.04 amd64 各一个安装器。Android 签名 APK 的 versionCode 为 `1000015`。[发布证据](evidence/release-0.1.0-20261115.json) |
| 公开预发布 | [v0.1.1-rc.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.1-rc.2)，`66a79e5d` | Windows、Ubuntu 和 Android 复用同一源码构建产物。Android versionCode 为 `1000029`。14 个附件长度及 SHA-256 校验通过，三个安装包均可匿名下载。[发布证据](evidence/release-0.1.1-rc.2-20261127.json) |
| 本机 Windows | `53c7385a` | 已整体维护三组件及管理前端，使用已有安装关系、驱动和运行数据。[现场联验](evidence/windows11-android-joint-53c7385a.json) |
| 本机 Android 平板 | `53c7385a`，versionCode `1000021` | 实体平板覆盖安装、原书签及同源媒体联验。[覆盖安装证据](evidence/windows11-android-tablet-upgrade-53c7385a.json) |

冻结 tag 对应运行源码。后续提交可更新安装验收工具或文档，安装包的源码标识和 SHA-256 取自同批发布清单。

## 本机 Windows

| 项目 | 核对值 |
| --- | --- |
| 进程所有权 | `StreamKitOrchestrator`，Automatic / LocalSystem，控制服务运行于 Session 0。Sunshine 和媒体网关由它在指定桌面会话启动 |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时 WLAN 管理入口 | `https://192.168.2.131:9000/login` |
| 数据面 | HTTPS 8080，Sunshine 内部基础端口 48989、管理端口 48990 |

11 月 27 日，`53c7385a` 实际整机重启后控制服务在 14.42 秒启动，Sunshine 与媒体网关在桌面会话中约 31 秒启动。WLAN 从 `192.168.0.119` 迁移到 `192.168.2.131`，管理、媒体 HTTPS 在原 CA 下恢复。同机 Web 验证 Example 实际解码和两位控制者的交接、撤权。平板在新 WLAN 的邻居解析失败，跨设备媒体恢复仍待验收。[整机与换址证据](evidence/windows11-reboot-and-lan-53c7385a-20261127.json)

Playwright CLI 驱动 Chrome 打开本机登录页及当前 WLAN 上的管理、媒体入口。11 月 28 日的直连检查确认两端口均通过当前 WLAN 地址建立 TLS 1.3。用固定主机名访问时，同机浏览器实际选中了虚拟网卡，因此跨设备的名称解析与媒体路径仍需现场验证。[WLAN 直连与固定主机名证据](evidence/windows11-direct-https-origins-53c7385a-20261128.json) · [地址与证书](lan-address-configuration.md)

## 修复与验收

| 核验项 | 已取得的证据 |
| --- | --- |
| RC2 Windows 安装和维护 | 使用公开包对应的原始字节。Windows Server 2022 托管静默安装、SCM/网关恢复、原生录音、卸载保留数据均通过。真实监听端口冲突后，回滚恢复原服务、永久链接、CA 和私钥。[安装与回滚证据](evidence/windows11-android-packaged-audio-66a79e5d-20261127.json) |
| RC2 全新 Win11 | 独立 Win11 26H2 x64 已启动，UEFI 安全启动与 TPM 通过。公开安装器在 Sunshine 首次凭据初始化时返回 `1`。原载荷另一次冷启动的原生初始化返回 `0`，总计 25.685 秒。追踪只记录到渲染进程开始，先前失败的确切退出原因仍待验证。后续源码将渲染初始化限时设为 60 秒并精简 Windows 渲染程序。新包仍需通过首装与重启验收。[首装失败与定位](evidence/windows11-clean-install-66a79e5d-20261128.json) |
| RC2 Android 与 Web | Win11 独立运行同包三组件及签名 APK，共用一条上游。授权后目标录音分析 96,000 帧且零丢帧，Web 麦克风信号从 −39.50 dB 降到撤权后的 −126.34 dB，程序声音保持。Android 覆盖升级、原书签复用、输入交接、权限拒绝、前后台及断网重连通过。[Win11 音频](evidence/windows11-android-packaged-audio-66a79e5d-20261127.json) · [Android 生命周期](evidence/android-input-66a79e5d-20261127.json) |
| RC2 换址 | 同源 Ubuntu 安装包在隔离网络实际换址。两个 HTTPS 端点在 2.743 秒内更新证书，原观看页恢复直接收发媒体，收到 48 帧视频和 79 个音频包。原 CA、私钥和组件进程保持。[换址证据](evidence/isolated-lan-66a79e5d-20261127.json) |
| 后续冻结版换址 | `439f2a06` Ubuntu 安装包在隔离网络实际换址。固定 mDNS 观看入口继续可用，两端 HTTPS 在 5.117 秒内更新证书。原观看页无需刷新即恢复直连，解码 52 帧并接收 86 个音频包。原 CA、私钥、配置和组件进程均保持。[换址证据](evidence/isolated-lan-439f2a06-20261128.json) |
| 后续冻结版 Android | `439f2a06` 签名 APK 从正式 `v0.1.0` 覆盖升级后直接打开原书签。Android 与 Web 共享一条串流，通过真实目标输入、控制权交接和撤销、录音权限拒绝、前后台切换及断线重连。本机官方模拟器的独立录音校准还采集了 240,000 帧并确认资源释放。[Android 联验证据](evidence/android-input-439f2a06-20261128.json) |
| 后续冻结版安装包与依赖 | `428f8036` Windows 安装包为 45,105,928 字节，3 个组件和 194 个清单文件全部校验通过。Sunshine 为 72,019,968 字节，PE 无调试节。Windows 与 Ubuntu 控制程序的 Go 符号扫描均未报告已知漏洞，APK 签名和当前 SBOM 已核对。[安装包与依赖证据](evidence/windows11-runtime-dependency-review-428f8036-20261128.json) |
| 后续冻结版卸载 | `428f8036` 的常规托管安装和卸载通过。带端口冲突的维护回滚也成功恢复原服务和观看身份，但同一次验收的最终卸载后，默认录音项仍指向产品虚拟端点。控制服务退出日志记录网关退出码 `-1`。代码已将启动取消与已接管组件的停机分开，修复后的安装包仍待验证。[卸载证据](evidence/windows11-hosted-uninstall-428f8036-20261128.json) |
| 后续冻结版 Android 回传 | `428f8036` 在 Win11 的独立产品串流子项通过，Android 麦克风同时到达目标录音和 Web，撤权后 Web 麦克风信号从 −51.60 dB 降到 −128.04 dB，程序声音继续播放。同次独立录音校准报错，整套联验保留失败状态。[回传子项与校准证据](evidence/windows11-android-packaged-audio-428f8036-20261128.json) |
| RC2 运行依赖 | 用精确 Windows、Ubuntu 控制二进制进行符号扫描。Android 发行签名、运行依赖和许可清单核对通过。继续引用经逐条复核的未变依赖图及源码 SBOM。[依赖审查及范围](evidence/windows11-runtime-dependency-review-66a79e5d-20261127.json) |
| 大应用包 | 流式上传和解压上限分别默认 50 GiB。Win11 通过浏览器和原生客户端上传、解压真实 26 GiB，入口哈希一致。核验暂存清理、空间不足反馈和大 ZIP64 / 7z 索引上限。资料分别记录实际源码和测试环境。[浏览器实传与截图](evidence/windows11-large-archive-20261127.json) · [磁盘保护](evidence/windows11-archive-space-666a6a01-20261127.json) · [归档条目限制](evidence/windows11-archive-index-38552c09-20261127.json) |
| 本机实体 Android | 同源现场 `53c7385a` 已验证共享媒体、真实目标操作及平板麦克风。实体平板输入交接和旧端失权另有 Playwright CLI 管理页实测和截图。[本机同源联验](evidence/windows11-android-joint-53c7385a.json) · [真机输入补验](evidence/android-input-tablet-954a1e6e-20261126.json) |
| 管理端实际页面 | Playwright CLI 验证 8 个路由在 3 种宽度的布局、配置草稿与语言。部分业务验收来自各版本的已安装页，证据保留实际组件身份。[布局及交互](evidence/management-layout-a616beba.json) · [已安装页验收](evidence/runtime-installed-954a1e6e-20261120.json) |
| 运行资源 | 已给服务器队列、认证失败连接、缓存、请求和日志设定预算。Web 帧读取器取消及关闭回归覆盖换轨和关闭。各项资源释放及采样覆盖范围见[资源审查](evidence/runtime-resource-review-20261113.json)、[原始资源采样](evidence/runtime-resources-ce52bdac-20261114.json)及[运行资源设计](runtime-resources.md)。 |

## 交付结果

每个服务端平台提供一个安装器，Android 提供原生签名 APK。下载附带源码版本、SHA-256、分发说明、许可证材料和 SBOM。[GitHub Releases](https://github.com/bei612/stream-kit/releases) · [RC2 安装与下载说明](../deploy/releases/0.1.1-rc.2.md)

此前版本的发布、失败及回归记录按原运行环境保留。[RC1 发布证据](evidence/release-0.1.1-rc.1-20261127.json) · [历史验收索引](https://github.com/bei612/stream-kit/blob/8c4ffb5bdc05fbfda73c305fcc0af9b8fb066af9/docs/release-status.md)

## 持续边界

- 正式 0.1.1 仍需冻结产物对应的 Win11 首装与整机恢复、实际安装上的维护回滚及跨设备现场换址。安装返回 `3010` 时需核对重启后的服务和音频准备。旧版已有一次独立环境返回 3010 的原始记录。[首装验收](../deploy/windows/README.md#首装和整机重启验收) · [旧版 3010 证据](evidence/windows-installer-restart-954a1e6e-20261120.json)
- Win11 主机换 IP 后，远端还需通过可达的固定主机名或新 IP 访问。固定主机名取决于现场 DNS/mDNS 和实际路由。独立 Linux 与本机 Web 的换址证据分别覆盖上述范围。实体设备跨网络恢复还需现场核对。
- 用户已接受原版本 20 客户端四小时稳定性与既有真人语音证据。本轮范围为 Win11 和 Android，Android 模拟器联验和实体平板的证据分别归档。[真人语音证据](evidence/human-voice-installed-20261105.json)
- 7×24 是资源设计目标。当前新版本尚无服务端、Web、Android 的完整 168 小时联合观测。通用 Windows 原位升级、多应用并行隔离及独立安全评估仍在当前已验证交付范围之外。[运行资源与释放](runtime-resources.md)
