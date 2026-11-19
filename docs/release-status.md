# 发布与部署基线

核对日期：2026-11-20。本页集中维护可下载版本、本机部署、候选产物和剩余边界。历史证据保留原始来源，不把旧版通过结果当作新产物验收。

源码 `954a1e6e` 新增共用概念气泡的视口避让和生命周期修复：原安装版手机宽度 390px 时隐藏气泡撑至 639px，已在实际安装页面复现。新构建的真实管理服务/SPA 已通过键盘、触屏、配置冲突和组件启停定向检查，Playwright CLI 的 8 路由 × 3 宽度及中英文气泡通过；尚待新同源产物及本机安装验收，不能称已安装。详见[修复审查](evidence/management-tooltip-review-20261119.json)。运行依赖审查发现一个 React Router 告警包；[逐公告适用性核查](evidence/management-dependency-review-20261119.json)未发现当前调用方式暴露所列攻击路径，包仍未升级，不声明扫描清零。

本机 Windows 三个运行组件及其前端现已统一为 `1d81a373ac29b243227e8f0fb55c1d9da3d613fd`，完整原生库存校验通过；管理端资源为 `index-CgQg9KWJ.js` / `index-D0xbfk5M.css`。已结束此前旧后端与单独覆盖前端的混合安装状态。服务为 Auto / LocalSystem / Running；当前 IP 自动识别、双入口可信 HTTPS、Example 实际出画面、双端控制转交/撤销与权限同步、停止后编辑和全局头像退出已通过。见[本机同源维护与页面验收](evidence/runtime-installed-1d81a373-20261119.json)。

已公开的最新预发布运行源码冻结为 `1d81a373ac29b243227e8f0fb55c1d9da3d613fd`，包含局域网地址自动识别、控制端/网关证书热更新及 OpenSSL 4.1 兼容。Windows/Linux 完整产品[构建已通过](https://github.com/bei612/stream-kit/actions/runs/44512398135)，三个组件均同源；该版 Android 的真机媒体证据保留，平板随后更新至下表 `954a1e6e` 候选。[v0.1.0-preview.20261119.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.2) 已发布且全部附件下载核验通过。Windows 本机完整维护现已成功；此前就绪检查失败、回滚和提权取消保留在[历史尝试记录](evidence/windows-maintenance-attempt-1d81a373-20261119.json)，不改写为成功。

自动换址已通过[真实隔离网络验证](evidence/lan-autodiscovery-515b9918-20261119.json)：移除旧 IP 并新增 IP 后，6.93 秒内两个 HTTPS 入口更新身份，CA、私钥、配置与进程保持，WebRTC 自动恢复到新媒体地址。该实验实际运行 `515b9918`；其管理端和网关源码与 `1d81a373` 完全一致，记录仍保留原始运行身份。本页下方手动地址恢复记录证明的是更新前的本机状态。

## 当前版本

| 对象 | 版本 / 来源 | 状态 |
| --- | --- | --- |
| 公开 Windows / Ubuntu 24.04 amd64 服务端 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2e933fb597e97dec999cceae9a3e614e1` | 11 月 15 日正式版，每平台一个安装器；不含本次自动换址功能 |
| 公开签名 Android | [v0.1.0 同一 Release](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，同源 `f8ede8b2`，versionCode 1000015 | 已公开 APK、来源、校验和、依赖许可证和 SBOM，沿用持久发行签名 |
| 本机运行组件及前端 | `1d81a373ac29b243227e8f0fb55c1d9da3d613fd` | 三组件完整维护与库存校验通过；实际 Web / Example 及自动当前 IP 身份通过，保留原安装器/卸载器和签名驱动 |
| 新公开预发布服务端 / Android | [v0.1.0-preview.20261119.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.2)，`1d81a373` | Windows / Ubuntu 24.04 amd64 单文件安装器及持久签名 APK 已发布；本机运行组件和 Android 与之同源，尚未替代正式 0.1.0 |
| 本机平板 Android | 0.1.0-preview.20261119.3 / versionCode 1000018，`954a1e6e` | [新安装证据](evidence/android-installed-954a1e6e-20261119.json)：签名、21 项库存校验、覆盖安装、原加密书签哈希保持和实际入口通过；Android 源码及 8 个原生库哈希与上一版相同。服务端仍为 `1d81a373`，不称新全套已安装 |
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
| Android 实体平板定向验收 | [1d81a373 真机记录](evidence/android-tablet-1d81a373-20261119.json)：原生永久入口启动 Example，初始实际解码 90 帧，Android 与 Web 共用一上游；管理页转交控制后平板变旁观者并停止录音。切后台释放 Android 连接，Web 保持；回前台重新解码、以旁观者加入且未自动录音。原加密书签恢复摘要一致，两个 testOnly 辅助 APK 已卸载，全部测试会话已停止。目标输入失败/音频未验收和辅助工具失败如实保留 |
| Android 实体平板音频补验 | [同源真机音频](evidence/android-tablet-audio-1d81a373-20261119.json)：临时显式配置现有项目虚拟端点，程序音使 Android 解码累计能量升至 0.0807；实际平板麦克风到服务器录音端点的最大 RMS 由 0.0000154 升至 0.00497，撤权后为 0.0000156；Web 观众最大 RMS 为 0 → 0.0435 → 0。未要求讲话、不保存 PCM，不代表声学音质或语音可懂度验收；网关少量丢帧和客户端补偿样本保留。Example 参数、会话路由、原书签均恢复，辅助工具卸载，零活动测试会话 |
| 本机最新同源运行与页面 | [1d81a373 实际验收](evidence/runtime-installed-1d81a373-20261119.json)：完整三组件库存、自动当前 LAN IP、原 CA 下双入口 HTTPS、真实永久链接启动 Example 并解码、双独立 Web 客户端共享会话与控制授予/转交/撤销及两端权限同步、停止后可编辑、全局头像退出和路由保护通过；6 张实际截图已目视核查，页面异常为 0；未启动 UE，不替代目标输入执行、音频、平板或真实换址验收 |
| 自动识别地址与双入口热更新 | [真实隔离迁移](evidence/lan-autodiscovery-515b9918-20261119.json)：新 IP 的原 CA 校验、旧 SAN 移除、三进程/配置/私钥保持及 WebRTC 新地址恢复通过；首次脚本权限失败及修复单独保留，不等同于本机 Windows/Android 真机迁移 |
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

新预发布 [v0.1.0-preview.20261119.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.2) 已通过[发布任务](https://github.com/bei612/stream-kit/actions/runs/44519865634)公开，14 个附件包括 Windows/Linux 安装器、Android APK/分发包、来源清单、SHA-256 及 SBOM；发布未重建运行产物。远端 tag 指向 `1d81a373`，GitHub 存储摘要与本地可对应的 10 个附件一致。全部 14 个附件已完成实际下载的字节数和 SHA-256 校验，其中 10 个为匿名下载，其余 4 个通过 GitHub 资产 API 完成。先前网络超时、CLI 二进制输出过滤及下载时限失败保留在[预发布证据](evidence/release-preview-20261119.2.json)，后续只完成未通过附件，未重跑已通过下载。本机随后已完成同源运行组件维护；安装与页面证据独立见上文，公开下载核验不替代运行验收。

正式 0.1.0 的 Windows/Linux 安装器、Android APK、源码 tag、校验和及许可证材料已发布；其本机完整组件维护与联合回归保留原始证据。资源采样已收齐，不重复未受影响的四小时或 100 次循环。原完整跨平台 CI 六项已通过；一次 Ubuntu 任务因官方 Chrome 下载的 HTTP/2 中断重试，只重跑失败任务，未重建原冻结产品。公开附件与实际下载核验见[0.1.0 发布证据](evidence/release-0.1.0-20261115.json)。

新候选 Windows 安装器为 `stream-kit-preview-1d81a373ac29-windows-amd64-setup.exe`，97,995,563 字节，SHA-256 `568a2cd5736582a721f26a00a329e40909e4123327b1432b07b8d4669579a562`。[同一字节安装验收](evidence/windows-installer-1d81a373-20261119.json)已通过：安装/卸载退出码 0、真实 PCM 144,480 帧且零丢帧/缓冲异常、网关与 Auto / LocalSystem 服务重启恢复、默认设备和数据保留均通过。未重新构建产物。

此前[首次全新安装](https://github.com/bei612/stream-kit/actions/runs/44517278501)安装成功但返回原生驱动要求重启的 `3010`，其 PCM 和服务生命周期检查未执行；卸载和数据保留通过。该真实结果保留，后一次成功不代表所有 Windows 环境首次装驱动都无需重启。验收器补充了有界 PnP/SetupAPI 诊断，保持原通过门槛；本机维护保留已有驱动，与全新驱动安装是不同路径。

## 持续边界

- 冻结源码 `954a1e6e` 的最新完整跨平台运行 [44556521128](https://github.com/bei612/stream-kit/actions/runs/44556521128) 六项均已成功，覆盖管理端、Windows/Linux 网关与控制端及 SBOM；原运行 [44518792780](https://github.com/bei612/stream-kit/actions/runs/44518792780) 的语言选择和依赖源失败保留为历史结果。管理端详细产物已下载，Chromium、Firefox、WebKit 与组件启停四组结果的源码身份及零未预期错误均已核对；完整产品的 Windows 安装器仍在构建，不能将 CI 成功当作新版本已在本机安装。依赖安装报告 19 项告警（含开发依赖），运行依赖适用性见上方逐公告审查，不能声明全依赖安全审计完成。
- 2026-11-19 17:16 的实际开机记录对应升级前版本，三个组件自动启动已观察通过。新版 1d81a373 已验证 Auto 服务及组件重启恢复，尚未执行整机重启验收；不承诺每次开机均无故障。
- 本机新 LAN 管理入口、自动当前 IP 身份和真实 Web 视频已通过；真实主网卡迁移后的 Windows/Android 完整媒体及输入恢复尚未验收。独立 Linux 实验不覆盖此环境。
- 平板当前真机已通过视频、共享会话/控制、录音生命周期，以及补验中的程序音、物理麦克风至目标端点/Web 观众与撤权静音。Example 键鼠计数未增加，Windows 拒绝向其窗口授予前台焦点；后续只读核查确认当前前台为 `LockApp`（会话 1），与宿主机锁屏及焦点拒绝一致，不倒推每次早先操作的前台身份。程序模式按设计拒绝向其他前台窗口注入，没有绕过此保护、强制解锁或改动 ToDesk。首轮无录音端点和测试音的零能量记录仍保留，后续补验不改写它。旧模拟器输入证据保持其原环境边界；真机输入尚不能标为通过。
- [Linux 模拟器音频负例](evidence/android-audio-fixture-ce52bdac-20261114.json)保留；旧 APK 在该环境的近静音未解释。Windows 通过不改写其他环境的失败，也不降低采集门槛。
- 用户已接受原版本 20 客户端四小时稳定性，不重复 24 小时；真人语音保留[原始证据](evidence/human-voice-installed-20261105.json)。本轮不要求 Linux/手机真机、特定 UE 内部录音或物理设备声学验收。
- 7×24 是设计目标，目前没有新版本服务端、Web、Android 的完整 168 小时证据，不能承诺永不 OOM。修复和精确产物定向验收通过后先发布，长期运行继续跟踪；不靠定时重启或强制 GC 替代释放。
- 一台渲染主机当前同时运行一个应用串流，可供多个客户端观看；不提供多应用并行隔离。Windows 通用自动原位升级、数据库自动降级、全依赖漏洞审计及独立安全评估不在已通过范围。
