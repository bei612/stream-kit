# 发布与部署基线

核对日期：2026-11-19。本页集中维护可下载版本、本机部署、候选产物和剩余边界。历史证据保留原始来源，不把旧版通过结果当作新产物验收。

本机前端已单独更新到 `d9585be3`（管理端资源 `index-E9ej8kHI.js` / `index-D0xbfk5M.css`），含文档、标题及 header 头像退出菜单；后端可执行文件仍为 `f8ede8b2`。这不是全组件同源新版安装，旧 bundle 清单不代表后来覆盖的静态文件已通过完整包校验；后续完整发行必须重新打包并验证，不能把当前混合安装称为源码、运行时和 Release 完全一致。

当前源码新增局域网地址自动识别及控制端/网关证书热更新。默认沿用已配置 CA，私有地址发现周期 15 秒、网关证书刷新周期 5 秒，策略可在服务配置关闭或限定网卡。源码通过验证不等于本机已安装；完整候选和本机更新结果在实际完成后登记。本页下方 11 月 19 日手动地址恢复记录仅证明更新前的现场状态。

## 当前版本

| 对象 | 版本 / 来源 | 状态 |
| --- | --- | --- |
| 公开 Windows / Ubuntu 24.04 amd64 服务端 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2e933fb597e97dec999cceae9a3e614e1` | 正式渠道，每平台一个安装器，包含本轮完整修复 |
| 公开签名 Android | [v0.1.0 同一 Release](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，同源 `f8ede8b2`，versionCode 1000015 | 已公开 APK、来源、校验和、依赖许可证和 SBOM，沿用持久发行签名 |
| 本机完整运行组件 | `f8ede8b2e933fb597e97dec999cceae9a3e614e1` | 控制端、网关和 Sunshine 同源；维护成功，实际 Web 先入、Android 后入联合回归通过 |
| 同源 Android 实测 | 0.1.0 / versionCode 1000015 | [构建来源](https://github.com/bei612/stream-kit/actions/runs/43609422069)，专用模拟器实际图像、程序音、麦克风及撤权通过，安装字节及重启后摘要一致；模拟器已停止 |

正式 0.1.0 已发布，当前核心功能达到本页所列产物与环境的发布条件；整个 Goal 仍有下文的整机重启和真实地址迁移等验收边界。发布复用[原始产品构建](https://github.com/bei612/stream-kit/actions/runs/43609416420)的字节，经[发布任务](https://github.com/bei612/stream-kit/actions/runs/43613696666)校验并上传；tag 指向冻结运行源码，文档及验收器后续提交不改变产物身份。

## 本机 Windows

| 项目 | 当前值 |
| --- | --- |
| 服务 | `StreamKitOrchestrator`，自动启动，LocalSystem |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时 LAN 入口 | `https://192.168.0.119:9000/login` |
| 网关 / 渲染端内部端口 | HTTPS 8080 / 原生 48989、管理 48990 |

完整运行组件的既有维护保留原安装器、卸载器和驱动；后续静态前端更新范围见上文。管理员凭据和观看密钥不写入文档或日志。

2026-11-19 本次实际开机时间 17:16:32，人工维护前查到控制服务 17:16:47、网关 17:16:48、Sunshine 17:16:49 已启动，健康接口全部 running、崩溃计数为 0。此次访问失败原因是 WLAN 地址已由 `192.168.3.27` 改为 `192.168.0.119`，新 IP 不在原证书中。已备份受保护配置及证书，将新 IP 加入 `server.lan_tls.hosts`，通过两个组件原生配置检查并重启归属服务；原 CA、CA 私钥、服务私钥和应用记录保持。管理端及网关新 IP 的 TLS 校验通过，Playwright CLI 实际登录页和截图通过。无活动应用被中断，未启动 UE 或执行新媒体串流验收。见[开机与地址恢复证据](evidence/windows-boot-address-20261119.json)及[登录页面截图](evidence/windows-boot-address-20261119.png)。

Sunshine 即使使用外部配置，仍要求程序旁存在空 `config` 目录。首次安装会建立它，维护器现在也在管理员暂存阶段建立，并拒绝覆盖非空本地状态；不放宽 Program Files 权限。原失败及回滚、原生复现和后续成功分别保留，见[已安装验收](evidence/runtime-installed-ce52bdac-20261114.json)及[部署维护](../deploy/README.md)。

LAN IP 是现场值，不是内置地址。更换 IP 后按[地址与证书](lan-address-configuration.md)更新 TLS 身份及必要的公开地址/来源/ICE 配置并重启，保留部署 CA 和观看密钥，无需重新编译或重装客户端 CA。数字 IP 书签不会自动改写；服务重启不等于整机重启验收。

## 修复与验收

| 内容 | 证据与范围 |
| --- | --- |
| 服务端持续资源上限与释放 | [资源审查](evidence/runtime-resource-review-20261113.json)：帧元数据、握手失败连接、媒体队列、缓存、HTTP 响应和日志清理，已纳入本机及候选；资源所有权见[运行资源](runtime-resources.md) |
| 控制请求和操作锁 | [生产复审](evidence/production-readiness-review-20261114.json)：控制体统一 1 MiB，固定长度/chunked 超限返回 413，上传保留独立预算；锁仅保留活动所有者，20,000 次完成后归零 |
| 浏览器帧生命周期 | Canvas reader 取消、finally 释放、迟到帧关闭；原生 Chrome 100 次换轨/关闭及异常分支通过，MSE/WebCodecs 原生检查通过，已纳入本机和候选 |
| 本机实际 UI / 循环 | [ce52bdac 验收](evidence/runtime-installed-ce52bdac-20261114.json)：严格 HTTPS、永久入口启动 Example、双端 1920×1080、唯一控制授予/交接/撤销、断开隔离、停止后可编辑；100 次真实进入/解码/工具栏退出，各批恢复单连接，无页面异常 |
| 默认 H.264 混合连接 | ce52 Web 先入声明 High 4:4:4，Android 后入被拒。f8ede8b2 将两端默认统一为普通 H.264 掩码 0x0001，高阶格式仍可显式选择实验性 auto；[新本机联合回归](evidence/runtime-installed-f8ede8b2-20261115.json)证明 Web 先启动、Android 后加入，同一会话持续解码，实际 H.264 profile-level-id=64001f |
| 精确 Windows 安装器 | [f8ede8b2 安装验收](evidence/windows-installer-f8ede8b2-20261114.json)：原始字节静默安装、自启动、网关恢复、SCM 重启、144000 帧原生录音、卸载及数据保留通过；不代替本机维护或整机重启 |
| 实际资源观察 | [ce52bdac 原始计数](evidence/runtime-resources-ce52bdac-20261114.json)：45.64 分钟混合负载采样未含 SCM 主服务；补充 14.51 分钟已预热单观看端完整采样，主服务 64.63→64.28 MiB、网关 19.99→20.00 MiB、浏览器进程合计 566.26→581.92 MiB，句柄未持续累积。为部署已就绪的新包提前结束窗口；不标成计划时长完成，不推断长期无泄漏 |
| 新候选 Linux 实际页面 | [f8ede8b2 页面验收](evidence/management-live-f8ede8b2-20261114.json)：原始统一包、可信 HTTPS、真实双 WebRTC 解码、唯一控制交接、参数保存恢复及桌面/手机截图；不含 Android 音频或长跑 |
| Windows Android / Web 音频 | [ce52 音频验收](evidence/android-audio-windows-ce52bdac-20261114.json)：Android 程序音 239999 帧 / 49 窗口，Web 程序音、合成麦克风到真实录音端点和观众、撤权静音通过。采用 Android 先入，仅证明音频链路；参数、路由、音量均恢复，无保存 PCM |
| 新本机同源联合验收 | [f8ede8b2 实际运行](evidence/runtime-installed-f8ede8b2-20261115.json)：Web 先入；Android 程序音 49/49 窗口、Web 程序音通过，Android 合成麦克风到原生录音端点及 Web 观众，撤权后两端静音、零采集丢帧；停止后零活动会话/连接/媒体观测。测试参数、路由和音量恢复，模拟器已停止，服务 Auto/LocalSystem/Running |
| 原生输入和独立地址恢复 | [输入六阶段](evidence/android-input-db01e6c6-20261114.json)、[独立 Linux 网卡迁移](evidence/lan-address-recovery-db01e6c6-20261114.json)保留实际来源，不代替本机 Windows 主网卡或新 APK 验收 |
| 管理端统一布局 | [布局与交互](evidence/management-layout-a616beba.json)：8 路由共用容器/栅格/导航，覆盖手机、平板、桌面、草稿保留与冲突；新候选实际页面另见上行，维护契约见[管理布局](management-layout.md) |

检查使用独立 Example、外部采样器和专用模拟器，不进入生产安装包或 APK。不启动或修改其他代理维护的 UE，不修改 ToDesk、宿主机默认音频或客户端信任来绕过问题。

## 交付结果

同源 Windows/Linux 安装器、Android APK、源码 tag、校验和及许可证材料已发布；本机完整组件维护与受影响的联合回归已完成。资源采样已收齐，不重复未受影响的四小时或 100 次循环。完整跨平台 CI 六项已通过；一次 Ubuntu 任务因官方 Chrome 下载的 HTTP/2 中断重试，只重跑失败任务，未重建冻结产品。公开附件与实际下载核验见[0.1.0 发布证据](evidence/release-0.1.0-20261115.json)。

## 持续边界

- 2026-11-19 本次共享 Windows 主机实际开机后的三个运行组件自动启动已观察通过；这不承诺每次开机均无故障，也不等同于应用自动启动或完整媒体验收。
- 本机新 LAN 管理入口已恢复；真实主网卡迁移后的 Windows/Android 完整媒体及输入恢复尚未验收。独立 Linux 实验不覆盖此环境。
- [Linux 模拟器音频负例](evidence/android-audio-fixture-ce52bdac-20261114.json)保留；旧 APK 在该环境的近静音未解释。Windows 通过不改写其他环境的失败，也不降低采集门槛。
- 用户已接受原版本 20 客户端四小时稳定性，不重复 24 小时；真人语音保留[原始证据](evidence/human-voice-installed-20261105.json)。本轮不要求 Linux/手机真机、特定 UE 内部录音或物理设备声学验收。
- 7×24 是设计目标，目前没有新版本服务端、Web、Android 的完整 168 小时证据，不能承诺永不 OOM。修复和精确产物定向验收通过后先发布，长期运行继续跟踪；不靠定时重启或强制 GC 替代释放。
- 一台渲染主机当前同时运行一个应用串流，可供多个客户端观看；不提供多应用并行隔离。Windows 通用自动原位升级、数据库自动降级、全依赖漏洞审计及独立安全评估不在已通过范围。
