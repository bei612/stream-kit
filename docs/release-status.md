# 发布与部署基线

核对日期：2026-11-14。本页集中维护可下载版本、本机部署、候选产物和剩余边界。历史证据保留原始来源，不把旧版通过结果当作新产物验收。

## 当前版本

| 对象 | 版本 / 来源 | 状态 |
| --- | --- | --- |
| 公开 Windows / Ubuntu 24.04 amd64 服务端 | [v0.1.0-preview.20261110.5](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261110.5)，`3d4a3b5c61fea72354318cea637b3428052e5cfc` | 未包含本轮完整修复 |
| 公开签名 Android | [v0.1.0-android-preview.20261109.6](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-android-preview.20261109.6)，`df7cd87b3352a638aa3a6aa7073d39074c02a43c`，versionCode 1000013 | 尚未更新公开下载 |
| 本机完整运行组件 | `ce52bdace58abb4dc13dc3eec4727daa6549a88f` | 控制端、网关和 Sunshine 同源；维护部署成功，默认 Web 先入的 H.264 混合连接问题待更新 |
| 冻结的 0.1.0 候选 | `f8ede8b2e933fb597e97dec999cceae9a3e614e1` | [统一产品任务](https://github.com/bei612/stream-kit/actions/runs/43609416420)：Linux 已完成、Windows 构建中 |
| 同源签名 Android 候选 | 0.1.0 / versionCode 1000015 | [构建成功](https://github.com/bei612/stream-kit/actions/runs/43609422069)，已安装专用模拟器，等待新 Windows 联合回归 |

尚未完成正式 0.1.0 发布。本机运行、构建成功或单项验收通过不能单独代表整个 Goal 完成。发布复用已验收的原始字节，tag 指向冻结运行源码；文档及验收器的后续提交不改变产物身份。

## 本机 Windows

| 项目 | 当前值 |
| --- | --- |
| 服务 | `StreamKitOrchestrator`，自动启动，LocalSystem |
| 程序 / 数据目录 | `C:\Program Files\StreamKit` / `C:\ProgramData\StreamKit` |
| 本机管理入口 | `https://127.0.0.1:9000/login` |
| 核对时 LAN 入口 | `https://192.168.3.27:9000/login` |
| 网关 / 渲染端内部端口 | HTTPS 8080 / 原生 48989、管理 48990 |

这是保留数据的完整运行组件维护，不是重跑新统一安装器；原安装器、卸载器和驱动保留。维护已核对配置字节、应用身份及部署信任不变，失败会恢复原组件。管理员凭据和观看密钥不写入文档或日志。

Sunshine 即使使用外部配置，仍要求程序旁存在空 `config` 目录。首次安装会建立它，维护器现在也在管理员暂存阶段建立，并拒绝覆盖非空本地状态；不放宽 Program Files 权限。原失败及回滚、原生复现和后续成功分别保留，见[已安装验收](evidence/runtime-installed-ce52bdac-20261114.json)及[部署维护](../deploy/README.md)。

LAN IP 是现场值，不是内置地址。更换 IP 后按[地址与证书](lan-address-configuration.md)更新 TLS 身份及必要的公开地址/来源/ICE 配置并重启，保留部署 CA 和观看密钥，无需重新编译或重装客户端 CA。数字 IP 书签不会自动改写；服务重启不等于整机重启验收。

## 修复与验收

| 内容 | 证据与范围 |
| --- | --- |
| 服务端持续资源上限与释放 | [资源审查](evidence/runtime-resource-review-20261113.json)：帧元数据、握手失败连接、媒体队列、缓存、HTTP 响应和日志清理，已纳入本机及候选；资源所有权见[运行资源](runtime-resources.md) |
| 控制请求和操作锁 | [生产复审](evidence/production-readiness-review-20261114.json)：控制体统一 1 MiB，固定长度/chunked 超限返回 413，上传保留独立预算；锁仅保留活动所有者，20,000 次完成后归零 |
| 浏览器帧生命周期 | Canvas reader 取消、finally 释放、迟到帧关闭；原生 Chrome 100 次换轨/关闭及异常分支通过，MSE/WebCodecs 原生检查通过，已纳入本机和候选 |
| 本机实际 UI / 循环 | [ce52bdac 验收](evidence/runtime-installed-ce52bdac-20261114.json)：严格 HTTPS、永久入口启动 Example、双端 1920×1080、唯一控制授予/交接/撤销、断开隔离、停止后可编辑；100 次真实进入/解码/工具栏退出，各批恢复单连接，无页面异常 |
| 默认 H.264 混合连接 | ce52 Web 先入声明 High 4:4:4，Android 后入被拒。f8ede8b2 将两端默认统一为普通 H.264 掩码 0x0001，高阶格式仍可显式选择实验性 auto；Web 构建及原生 Java 四项通过，等待新 Windows 实际联合回归 |
| 精确 Windows 安装器 | [ce52 安装验收](evidence/windows-installer-ce52bdac-20261114.json)：原始字节静默安装、自启动、网关恢复、SCM 重启、原生录音、卸载及数据保留通过；不代替 f8 新安装器或整机重启 |
| 新候选 Linux 实际页面 | [f8ede8b2 页面验收](evidence/management-live-f8ede8b2-20261114.json)：原始统一包、可信 HTTPS、真实双 WebRTC 解码、唯一控制交接、参数保存恢复及桌面/手机截图；不含 Android 音频或长跑 |
| Windows Android / Web 音频 | [ce52 音频验收](evidence/android-audio-windows-ce52bdac-20261114.json)：Android 程序音 239999 帧 / 49 窗口，Web 程序音、合成麦克风到真实录音端点和观众、撤权静音通过。采用 Android 先入，仅证明音频链路；参数、路由、音量均恢复，无保存 PCM |
| 原生输入和独立地址恢复 | [输入六阶段](evidence/android-input-db01e6c6-20261114.json)、[独立 Linux 网卡迁移](evidence/lan-address-recovery-db01e6c6-20261114.json)保留实际来源，不代替本机 Windows 主网卡或新 APK 验收 |
| 管理端统一布局 | [布局与交互](evidence/management-layout-a616beba.json)：8 路由共用容器/栅格/导航，覆盖手机、平板、桌面、草稿保留与冲突；新候选实际页面另见上行，维护契约见[管理布局](management-layout.md) |

检查使用独立 Example、外部采样器和专用模拟器，不进入生产安装包或 APK。不启动或修改其他代理维护的 UE，不修改 ToDesk、宿主机默认音频或客户端信任来绕过问题。

## 交付待办

1. 完成 f8ede8b2 Windows 原始安装器及精确安装验收，部署完整同源组件。
2. 用新 APK 验证默认 Web 先入、Android 后入的共享串流及音频撤权；不重复未受影响的四小时和 100 次循环。
3. 收齐正在进行的资源观察，区分包含 SCM 主服务的完整样本和旧采样范围；更新证据、提交并发布 Windows/Linux 安装器及同源签名 APK。

## 持续边界

- 共享 Windows 主机实际整机重启、登录后无需人工补启动的流程尚未验收。安装器自启动与组件恢复检查不能替代整机验证。
- 本机新 LAN 管理入口已恢复；真实主网卡迁移后的 Windows/Android 完整媒体及输入恢复尚未验收。独立 Linux 实验不覆盖此环境。
- [Linux 模拟器音频负例](evidence/android-audio-fixture-ce52bdac-20261114.json)保留；旧 APK 在该环境的近静音未解释。Windows 通过不改写其他环境的失败，也不降低采集门槛。
- 用户已接受原版本 20 客户端四小时稳定性，不重复 24 小时；真人语音保留[原始证据](evidence/human-voice-installed-20261105.json)。本轮不要求 Linux/手机真机、特定 UE 内部录音或物理设备声学验收。
- 7×24 是设计目标，目前没有新版本服务端、Web、Android 的完整 168 小时证据，不能承诺永不 OOM。修复和精确产物定向验收通过后先发布，长期运行继续跟踪；不靠定时重启或强制 GC 替代释放。
- 一台渲染主机当前同时运行一个应用串流，可供多个客户端观看；不提供多应用并行隔离。Windows 通用自动原位升级、数据库自动降级、全依赖漏洞审计及独立安全评估不在已通过范围。