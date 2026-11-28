# 发布与部署基线

核对日期 2026-11-28。这里记录可下载版本、现场安装及验收范围。安装、配网和维护操作分别见 [Windows 安装](../deploy/windows/README.md)、[地址与证书](lan-address-configuration.md)和[部署运维](../deploy/README.md)。

## 当前版本

| 对象 | 版本 | 对应交付 |
| --- | --- | --- |
| 公开正式版 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2` | Windows 和 Ubuntu 24.04 amd64 各一个安装器。Android 签名 APK 的 versionCode 为 `1000015`。[发布证据](evidence/release-0.1.0-20261115.json) |
| 公开预发布 | [v0.1.1-rc.4](https://github.com/bei612/stream-kit/releases/tag/v0.1.1-rc.4)，`bb3c8d24` | Windows、Ubuntu 和 Android 使用同一源码构建，Android versionCode 为 `1000033`。14 个附件均可匿名下载，文件长度及 SHA-256 已核对。[发布证据](evidence/release-0.1.1-rc.4-20261128.json) |
| 本机 Windows | `53c7385a` | 已整体维护三组件及管理前端，使用已有安装关系、驱动和运行数据。[现场联验](evidence/windows11-android-joint-53c7385a.json) |
| 本机 Android 平板 | `bb3c8d24`，versionCode `1000033` | 现场平板已覆盖安装使用项目密钥签名的候选包，原书签已保留并改用固定主机名。本次 Windows 仍为 `53c7385a`。[现场联验](evidence/windows11-tablet-mdns-signed-20261128.json) |

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

实体平板接入 Windows 所在的 WLAN 后，通过当前 IPv4 地址直接访问管理端与媒体网关，两端均以原部署 CA 完成 TLS 1.3 验证并返回 HTTP 200。平板系统仍无法解析 `volcengine.local`；本次证据覆盖独立设备的数字 IP 直连，固定主机名发现仍待解决。[平板直连证据](evidence/windows11-tablet-lan-53c7385a-20261128.json)

RC3 签名 APK 在实体平板使用当前 IPv4 观看链接启动 Example，实际解码 5,450 帧并收到 8,458 个 Opus 包。断网后 Android 自动选了另一已保存的 WLAN，串流未恢复。通过系统设置切回现场 WLAN 并回到应用后，原会话恢复画面，无需重输链接。现场授权和撤权已生效，Example 按键计数未递增，本次没有确认目标输入或声学表现。测试结束后 Example 已停止。[现场联验](evidence/windows11-tablet-rc3-onsite-20261128.json) · [恢复画面](evidence/windows11-tablet-rc3-onsite-reconnected-20261128.png)

固定主机名排查确认现场双向组播可达，Windows 对标准 mDNS 组播发回响应，平板系统解析仍未返回地址。两个端口的证书均覆盖该主机名，并受原 CA 信任。签名候选 APK `1000033` 从 RC3 覆盖安装后，平板通过「修改服务器地址」保留原应用密钥，改用 `volcengine.local`。重启 App 后用保存的书签启动 Example，实际解码 339 帧并收到 531 个 Opus 包。保留该书签与签名 App，Example 已停止。现场 Windows 在测试期间保持原地址，服务器换址仍需验收。[名称解析证据](evidence/windows11-tablet-mdns-20261128.json) · [签名版现场联验](evidence/windows11-tablet-mdns-signed-20261128.json) · [实体平板画面](evidence/windows11-tablet-mdns-signed-20261128.png)

首次 Win11 独立换址验收中，RC3 安装成功，重启后原生组件未在时限内全部就绪，换址阶段未执行。后续验收在安装与重启检查通过后才接入专用测试网卡，并在启动失败时记录控制端与组件状态。[首次换址验收记录](evidence/windows11-lan-rc3-first-run-20261128.json)

第二次 RC3 独立验收在原时限到期时仍处于 Windows 系统安装的 77%，尚未运行产品安装器。虚拟机操作系统准备、产品安装与重启、联网换址各自计时，产品服务就绪判定保持原标准。[系统准备超时记录](evidence/windows11-lan-rc3-setup-timeout-20261128.json)

RC4 在独立 Win11 使用与公开包 SHA-256 一致的安装器，首装返回 `0`。整机重启后控制服务、Sunshine 和媒体网关自动恢复，四个系统默认音频角色保持。原生录音采集 144,000 个采样帧，目标音频队列报告丢弃 1 个 20 ms 音频块。独立客户端在旧地址的 mDNS 核对未通过，该次未执行换址。后续任务同样通过首装检查点，结果采集脚本返回 JSON 解析错误，未取得重启后和换址的结果。[RC4 独立 Win11 首装及重启证据](evidence/windows11-lan-rc4-first-run-20261128.json) · [结果采集失败记录](evidence/windows11-lan-rc4-reporter-failure-20261128.json)

## 修复与验收

| 核验项 | 已取得的证据 |
| --- | --- |
| 当前签名候选 `1000033` | Android 与 Web 共用一条串流。真实目标键鼠、控制权交接与撤权、覆盖升级、前后台切换、设备录音权限拒绝和断网恢复均通过。Ubuntu 原观看页在实际换址后恢复直连，两端 HTTPS 在 9.326 秒内更新。Linux 模拟器独立音频校准失败，未执行产品音频联验。[客户端验收](evidence/android-input-bb3c8d24-20261128.json) · [隔离换址](evidence/isolated-lan-bb3c8d24-20261128.json) · [音频校准记录](evidence/android-linux-audio-fixture-bb3c8d24-20261128.json) |
| 当前候选 Windows 安装与回传 | `bb3c8d24` 原始 Windows 安装包已通过静默安装、服务恢复与卸载。托管 Windows 从 RC3 在实际端口冲突后回滚，移除冲突后成功应用 RC4，原观看链接、配置、CA 和卸载器得到保留。独立 Windows Android 模拟器已验证 Android/Web 共用一条串流，麦克风回传到目标录音与 Web，撤权后程序音继续播放。[安装](evidence/windows11-hosted-install-bb3c8d24-20261128.json) · [维护](evidence/windows11-hosted-maintenance-bb3c8d24-20261128.json) · [音频联验](evidence/windows11-android-packaged-audio-bb3c8d24-20261128.json) |
| RC2 Windows 安装和维护 | 使用公开包对应的原始字节。Windows Server 2022 托管静默安装、SCM/网关恢复、原生录音、卸载保留数据均通过。真实监听端口冲突后，回滚恢复原服务、永久链接、CA 和私钥。[安装与回滚证据](evidence/windows11-android-packaged-audio-66a79e5d-20261127.json) |
| RC2 全新 Win11 | 独立 Win11 26H2 x64 已启动，UEFI 安全启动与 TPM 通过。公开安装器在 Sunshine 首次凭据初始化时返回 `1`。原载荷另一次冷启动的原生初始化返回 `0`，总计 25.685 秒。追踪只记录到渲染进程开始，先前失败的确切退出原因仍待验证。后续源码将渲染初始化限时设为 60 秒并精简 Windows 渲染程序。新包仍需通过首装与重启验收。[首装失败与定位](evidence/windows11-clean-install-66a79e5d-20261128.json) |
| RC2 Android 与 Web | Win11 独立运行同包三组件及签名 APK，共用一条上游。授权后目标录音分析 96,000 帧且零丢帧，Web 麦克风信号从 −39.50 dB 降到撤权后的 −126.34 dB，程序声音保持。Android 覆盖升级、原书签复用、输入交接、权限拒绝、前后台及断网重连通过。[Win11 音频](evidence/windows11-android-packaged-audio-66a79e5d-20261127.json) · [Android 生命周期](evidence/android-input-66a79e5d-20261127.json) |
| RC2 换址 | 同源 Ubuntu 安装包在隔离网络实际换址。两个 HTTPS 端点在 2.743 秒内更新证书，原观看页恢复直接收发媒体，收到 48 帧视频和 79 个音频包。原 CA、私钥和组件进程保持。[换址证据](evidence/isolated-lan-66a79e5d-20261127.json) |
| 后续冻结版换址 | `8f5a078e` Ubuntu 安装包在隔离网络实际换址。固定 mDNS 观看入口继续可用，两端 HTTPS 在 9.632 秒内更新证书。原观看页无需刷新即恢复直连，解码 50 帧并接收 83 个音频包。原 CA、私钥、配置和组件进程均保持。[换址证据](evidence/isolated-lan-8f5a078e-20261128.json) |
| 后续冻结版 Android | `8f5a078e` 签名 APK `1000032` 从正式 `v0.1.0` 覆盖升级后直接打开原书签。Android 和 Web 共享一条串流，通过真实目标输入、控制权交接和撤销、录音权限拒绝、前后台切换及断线重连。[Android 联验证据](evidence/android-input-8f5a078e-20261128.json) |
| 后续冻结版安装包与依赖 | `8f5a078e` Windows 安装包为 45,118,937 字节，3 个组件的 190 个内容文件及 4 个清单已核对。Sunshine 为 72,019,968 字节，PE 无调试节。Windows 与 Ubuntu 控制程序的 Go 符号扫描均未报告已知漏洞，Android APK 签名和源代码 SBOM 已核对。[安装包与依赖证据](evidence/windows11-runtime-dependency-review-8f5a078e-20261128.json) |
| 后续冻结版托管维护与卸载 | `8f5a078e` 使用原始安装包通过静默首装、原生录音、控制服务与网关重启及卸载数据保留。另一台托管 Windows 从 `439f2a06` 迁移到新版录音策略，实际端口冲突后恢复原音频策略、服务、观看链接、CA 和私钥。[安装与策略回滚证据](evidence/windows11-hosted-uninstall-8f5a078e-20261128.json) |
| RC3 Win11 首装与重启 | `8f5a078e` 在干净 Win11 首装返回 `0`。整机重启后控制服务、Sunshine 和媒体网关自动恢复，原生录音 144,000 帧无丢帧。已有四个默认音频角色在首装、重启、服务重启和卸载后均保持。卸载移除服务并保留数据。[RC3 首装证据](evidence/windows11-clean-install-8f5a078e-20261128.json) · [前版端点证据](evidence/windows11-clean-install-439f2a06-20261128.json) |
| Windows 默认音频设备保护 | `8f5a078e` 在独立 Windows 专项中保留四个原有默认音频角色。虚拟音频设备重新接入后身份保持，指定端点仍能录得 144,000 帧 PCM，零丢帧。原始安装器首装、整机重启和已安装旧策略的回滚分别验收。[Windows 端点专项](evidence/windows-endpoint-defaults-8f5a078e-20261128.json) |
| 后续冻结版 Android 回传 | `8f5a078e` 的 Win11 原始三组件和签名 APK `1000032` 通过完整模拟器联验。Android 和 Web 共用一条上游，均收到 Example 程序声音。授权后的麦克风到达目标录音，分析 96,000 帧且零丢帧，同一信号可在 Web 听到。撤权后 Web 麦克风信号从 −42.57 dB 降到 −127.93 dB，程序声继续播放。独立录音校准与资源释放均通过。[同源音频联验](evidence/windows11-android-packaged-audio-8f5a078e-20261128.json) |
| RC2 运行依赖 | 用精确 Windows、Ubuntu 控制二进制进行符号扫描。Android 发行签名、运行依赖和许可清单核对通过。继续引用经逐条复核的未变依赖图及源码 SBOM。[依赖审查及范围](evidence/windows11-runtime-dependency-review-66a79e5d-20261127.json) |
| 大应用包 | 流式上传和解压上限分别默认 50 GiB。Win11 通过浏览器和原生客户端上传、解压真实 26 GiB，入口哈希一致。核验暂存清理、空间不足反馈和大 ZIP64 / 7z 索引上限。资料分别记录实际源码和测试环境。[浏览器实传与截图](evidence/windows11-large-archive-20261127.json) · [磁盘保护](evidence/windows11-archive-space-666a6a01-20261127.json) · [归档条目限制](evidence/windows11-archive-index-38552c09-20261127.json) |
| 本机实体 Android | 同源现场 `53c7385a` 已验证共享媒体、真实目标操作及平板麦克风。实体平板输入交接和旧端失权另有 Playwright CLI 管理页实测和截图。[本机同源联验](evidence/windows11-android-joint-53c7385a.json) · [真机输入补验](evidence/android-input-tablet-954a1e6e-20261126.json) |
| 管理端实际页面 | RC4 原始管理端与网关使用 Playwright CLI 实测。Example 启动前两种语言显示同一固定观看链接，两个 Web 观看端解码真实视频，控制权授予、交接及撤销经服务端验证。应用启动参数保存后复原。另有 8 个路由在 3 种宽度的布局证据。[RC4 操作验收](evidence/management-live-cli-bb3c8d24-20261128.json) · [移动端应用页](evidence/management-live-cli-bb3c8d24-app-mobile.png) · [桌面端控制权](evidence/management-live-cli-bb3c8d24-sessions-desktop.png) · [布局及交互](evidence/management-layout-a616beba.json) |
| 运行资源 | 已给服务器队列、认证失败连接、缓存、请求和日志设定预算。Web 帧读取器取消及关闭回归覆盖换轨和关闭。各项资源释放及采样覆盖范围见[资源审查](evidence/runtime-resource-review-20261113.json)、[原始资源采样](evidence/runtime-resources-ce52bdac-20261114.json)及[运行资源设计](runtime-resources.md)。 |

## 交付结果

每个服务端平台提供一个安装器，Android 提供原生签名 APK。下载附带源码版本、SHA-256、分发说明、许可证材料和 SBOM。[GitHub Releases](https://github.com/bei612/stream-kit/releases) · [RC4 安装与下载说明](../deploy/releases/0.1.1-rc.4.md)

此前版本的发布、失败及回归记录按原运行环境保留。[RC3 发布证据](evidence/release-0.1.1-rc.3-20261128.json) · [RC2 发布证据](evidence/release-0.1.1-rc.2-20261127.json) · [RC1 发布证据](evidence/release-0.1.1-rc.1-20261127.json) · [历史验收索引](https://github.com/bei612/stream-kit/blob/8c4ffb5bdc05fbfda73c305fcc0af9b8fb066af9/docs/release-status.md)

## 持续边界

- 正式 0.1.1 仍需完成当前候选的 Win11 独立换址验收、现场 Windows 原位维护及实体平板在该 Windows 主机换址后的恢复。安装返回 `3010` 时需核对重启后的服务和音频准备。[RC4 独立 Win11 记录](evidence/windows11-lan-rc4-first-run-20261128.json) · [旧版 3010 证据](evidence/windows-installer-restart-954a1e6e-20261120.json)
- Win11 主机换 IP 后，远端还需通过可达的固定主机名或新 IP 访问。固定主机名取决于现场 DNS/mDNS 和实际路由。独立 Linux 与本机 Web 的换址证据分别覆盖上述范围。实体设备跨网络恢复还需现场核对。
- 用户已接受原版本 20 客户端四小时稳定性与既有真人语音证据。本轮范围为 Win11 和 Android，Android 模拟器联验和实体平板的证据分别归档。[真人语音证据](evidence/human-voice-installed-20261105.json)
- 7×24 是资源设计目标。当前新版本尚无服务端、Web、Android 的完整 168 小时联合观测。通用 Windows 原位升级、多应用并行隔离及独立安全评估仍在当前已验证交付范围之外。[运行资源与释放](runtime-resources.md)
