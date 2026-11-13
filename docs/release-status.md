# 发布与部署基线

核对日期：2026-11-13。本文集中维护可下载版本、现场部署和验收边界，避免在多份长期文档重复声明“当前版本”。预发布不等于全部生产验收通过。

## 可下载产品

| 产品 | 发布标识 | 运行源码 / 身份 |
| --- | --- | --- |
| Windows / Ubuntu 24.04 amd64 统一服务端 | [v0.1.0-preview.20261110.5](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261110.5) | `3d4a3b5c61fea72354318cea637b3428052e5cfc` |
| 签名 Android APK | [v0.1.0-android-preview.20261109.6](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-android-preview.20261109.6) | `df7cd87b3352a638aa3a6aa7073d39074c02a43c`；versionCode `1000013` |

服务端发布复用已核验的原始产品字节。验收脚本提交 `a2e8529b` 与运行源码身份分别记录，不因只改验收器重建运行时。原始文件名和 SHA-256 以对应 Release 附件及[精确发布材料](evidence/unified-installers-3d4a3b5c.json)为准；Android 见[APK 材料](evidence/android-release-20261109-6.json)。发布不会自动替换已有安装。

## 本机 Windows 部署

这是保留现有数据的组件维护部署，三个组件不是同一提交；不能描述成重新安装了最新统一包。

| 项目 | 本机值 |
| --- | --- |
| 管理控制端 | `a616beba91d65d5456a599444c74ec49e7e95a4f`；统一响应式管理布局 |
| 媒体网关 | `40146db2ffa8b15040906cf130be8e89548c48da` |
| Sunshine | `47c02726c0161ebdec50911422d62845a9b6e59a` |
| Windows 服务 | `StreamKitOrchestrator`，自动启动，LocalSystem |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时的 LAN 管理入口 | `https://192.168.3.27:9000/login` |
| 网关 / 渲染端内部端口 | HTTPS `8080` / 原生 `48989`、管理 `48990` |

地址会随实际网络改变，表中 LAN IP 是核对时的现场值，不是程序内置地址。本机凭据仍在受保护配置中，不写入本文。

本机使用既有部署 CA，`server.lan_tls.hosts` 已包含核对时的 LAN 地址；管理端与网关共用该身份。本机及 LAN 管理登录页、LAN 网关页面已通过严格 HTTPS 校验，并有实际 playwright-cli 页面及截图检查。应用 ID、CA/CA 私钥和服务私钥保留；本次替换完整管理控制组件及其配套前端，网关与 Sunshine 二进制摘要保持。新 LAN 地址的完整媒体链路仍未重新验收。服务重启与配置维护不等于重新安装统一包或整机重启。

当前管理端的 8 个页面共用容器、标题、栅格、面板和响应式导航。已安装 HTTPS 页面通过桌面/手机全路由检查、真实配置展开和参数搜索、导航与断点检查；同一源码的独立原生后端验证覆盖平板、草稿保留、配置冲突及组件操作。维护规则见[管理端布局](management-layout.md)，精确范围见[布局验收](evidence/management-layout-a616beba.json)。本次没有重新执行媒体长跑，也未更新公开统一安装包。

## 已有验收及适用范围

2026-11-13 的[资源审查](evidence/runtime-resource-review-20261113.json)已修复持续帧元数据保留、握手失败连接释放、媒体队列/浏览器缓冲、配对证书身份、HTTP/缓存容量和操作日志清理问题，并完成定向原生回归。源码修复不自动改变上述现场版本；在更新部署记录前，不将这些修复描述为本机或公开安装包已生效。运行边界见[资源所有权](runtime-resources.md)。

| 内容 | 证据与边界 |
| --- | --- |
| 当前管理端布局 | [a616beba 布局与交互](evidence/management-layout-a616beba.json)：已安装 8 路由、390/1440px，设置额外覆盖 320/1023/1024/1920px；独立原生后端含 820px 平板。无整页横向溢出，无页面异常或已安装页面 HTTP 错误；不代表媒体链路重验 |
| 精确服务端安装包 | [统一安装器](evidence/unified-installers-3d4a3b5c.json)：Windows 实际静默安装、自启动配置、服务恢复、音频端点、卸载；Linux 原始产品页面操作；不等于整机重启 |
| 本机管理端与 Web | [本机真实 LAN 操作](evidence/management-overview-local-windows-3d4a3b5c.json)：双端解码、授予/交接/撤权、停止与参数保存恢复；当时地址为旧 LAN IP |
| 同源 Linux 管理 / Web | [Linux 实际页面](evidence/management-overview-linux-3d4a3b5c.json)：双观看端、统一状态、控制权和参数操作；不代表 Linux 真机性能 |
| Android 与 Web 联合运行 | [联合检查](evidence/android-joint-windows-571295af-20261110.json)：APK .6、控制端 `571295af`、官方 Windows 模拟器，覆盖控制交接、声音、麦克风到原生端点及观看端、断网和前后台 |
| Android 程序音及录音 | [Windows 音频](evidence/android-release-audio-windows-20261110.json)、[生命周期](evidence/android-release-lifecycle-windows-20261110.json)、[焦点](evidence/android-release-focus-windows-20261110.json)：各自旧部署版本和模拟器环境，不外推真机声学质量 |
| Android 实际目标输入 | [输入六阶段](evidence/android-stream-input-3d4f248c-20261110.json)：APK .6 与 `3d4f248c` 服务端；不等于本机最新版本输入重验 |
| 真人语音与稳定性 | [既有真人语音](evidence/human-voice-installed-20261105.json)按原版本保留；20 客户端四小时稳定性已接受，无需重复 24 小时 |
| 独立地址恢复 | [独立 Linux 网卡实验](evidence/lan-address-recovery-20261107.json)：可信名称解析与真实 WebRTC 恢复，不代替本机 Windows 实验 |

## 尚未闭合的生产验收

- 当前共享宿主机实际整机重启、登录后无人手工补启动的完整恢复流程仍未验收。
- 本机新 LAN IP 的管理与网关入口已恢复；同一永久入口在新地址的完整视频、音频、输入及 Android 联合恢复仍需独立 Example 验证。没有改网卡模拟迁移，也没有重装客户端 CA。
- Android .6 在 Linux 模拟器环境的[近静音负例](evidence/android-stream-audio-df7cd87b-20261109.json)尚未解释。Windows 结果不改写该失败，不向生产 App 加入探针。
- 物理设备的扬声器、耳机、输入法和特定 UE 内部录音按各自证据范围判断；本轮不要求 Linux 或手机真机验收。
- Windows 通用原位升级和数据库自动降级未提供。当前服务端渠道仍是 preview，不能宣布整个目标已完成。

当前地址更新是配置操作：加入新 TLS 身份，核对显式公开地址/来源/ICE 配置，重启服务。不存在任意 DHCP 地址变化都会自动更新数字 IP 证书或书签的保证。具体操作见[地址与证书](lan-address-configuration.md)。
