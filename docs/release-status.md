# 发布与部署基线

核对日期：2026-11-27。本页集中维护可下载版本、本机部署、候选产物和剩余边界。历史证据保留原始来源，不把旧版通过结果当作新产物验收。

[v0.1.1-rc.1](https://github.com/bei612/stream-kit/releases/tag/v0.1.1-rc.1) 已公开下载。Windows、Ubuntu 和 Android 共用 `d0a5b4c8` 冻结源码，发布复用原构建字节。14 个附件的长度及 SHA-256 已与 GitHub 存储核对，三个安装下载入口均通过匿名读取。正式最新版仍是 `v0.1.0`，现场 Win11 仍需验证首次安装和整机恢复、维护回滚及跨设备换址。[预发布证据](evidence/release-0.1.1-rc.1-20261127.json)

`66a79e5d` 候选包含流式上传、可用磁盘空间提示、磁盘预留和 ZIP、ZIP64、7z 条目限制。单个应用归档和解压总量均默认上限 50 GiB，两项可分别配置。同一卷需要同时容纳暂存归档和解压结果。Win11 上真实 26 GiB TAR 已上传、解压并登记至就绪，程序哈希一致。[上传用法与空间预算](user-guide.md#上传程序包) · [26 GiB 验收](evidence/windows11-archive-space-666a6a01-20261127.json)

同源 Windows 安装器通过托管静默安装、SCM 自动服务恢复、真实端口冲突后的维护回滚和卸载数据保留。Win11 独立运行同包三组件与同源签名 Android APK，Android 与 Web 实际共享一条渲染上游。授权后的 Windows 目标录音分析 96,000 帧，零丢帧，麦克风信号在 Web 上由 −39.50 dB 降至撤权后的 −126.34 dB，程序声继续播放。[Windows 与 Android 联验](evidence/windows11-android-packaged-audio-66a79e5d-20261127.json) · [同源依赖复核](evidence/windows11-runtime-dependency-review-66a79e5d-20261127.json)

后续候选 `66a79e5d` 的 Ubuntu 安装器已核对实际包体与嵌入载荷摘要。隔离 Linux 实际换址后，管理端和媒体网关在 2.743 秒内热更新证书，原观看页恢复直连，收到 48 帧视频和 79 个音频包；服务进程及部署 CA、私钥保持。[同源换址验收](evidence/isolated-lan-66a79e5d-20261127.json) · [原始联验](https://github.com/bei612/stream-kit/actions/runs/46016281321)

`66a79e5d` 的 Android APK `1000029` 已在本机核对 v2/v3 发行签名、源码提交和 21 项文件摘要。保留首轮统计观察器超时记录。修正验收工具后，同字节复验通过覆盖升级、原书签复用、输入交接与撤权、麦克风授权拒绝、前后台切换及客户端断网重连。切回前台和重连后的客户端音频包、解码帧均实际增长，控制者仍由服务端分配。[验收记录](evidence/android-input-66a79e5d-20261127.json) · [复验任务](https://github.com/bei612/stream-kit/actions/runs/46018701153)

当前 0.1.1 构建候选冻结于 `d0a5b4c804ce26006a9e6ed277ff0077d92b5b11`。Windows 和 Ubuntu 安装器及 Android `1000027` APK 已同源构建。Windows 安装器为 98,140,982 字节，SHA-256 为 `5bc7beebe193e24d38fe3b73744322c9c83706d118c34fd327675cdaec7f1f23`，其三组件清单与已下载的本机测试载荷相符。APK 为 33,168,191 字节，SHA-256 为 `d9649cd76aa8b548ba5ed594ef9eab7e65324c940170a72c6127957b3b8c435b`，已核对项目 v2/v3 签名、包内源码标识、21 项分发文件及 4 项下载摘要。Ubuntu 安装器原生初始化通过。[Android 候选](https://github.com/bei612/stream-kit/actions/runs/45992345078) · [同源安装器](https://github.com/bei612/stream-kit/actions/runs/45992346158)

最新 Windows 安装器在 Windows Server 2022 托管环境完成实际静默安装、网关和 SCM 服务重启、原生录音及卸载数据保留。SCM 为 Auto / LocalSystem，安装和卸载退出码均为 0，录音为 144,000 帧，零丢帧和缓冲异常，既有默认音频设备保持。另一独立任务实际触发候选控制端端口占用，启动返回 1。回滚后原三组件、原永久观看链接、配置、CA 与私钥通过核对。[精确安装验收](https://github.com/bei612/stream-kit/actions/runs/45998883578) · [真实回滚验收](https://github.com/bei612/stream-kit/actions/runs/45998956057)

Win11 首装验收脚本可在安装返回 `0` 或 `3010` 时保存检查点，并在整机重启后先记录系统启动时间、三个进程的可执行文件归属和会话，再检查音频及服务恢复。现有托管场景已用公开 RC1 原包回归通过。专用 Win11 上的整机续验仍待执行。[Win11 首装验收说明](../deploy/windows/README.md#首装和整机重启验收) · [公开 RC1 安装回归](https://github.com/bei612/stream-kit/actions/runs/46005289301)

实际 Win11 独立实例使用最新同包三组件和 `1000027` APK。Android 与 Web 共享一条渲染上游。授权时，Windows 目标录音分析了 96,000 帧且零丢帧，Web 中的麦克风测试信号为 −42.95 dB；撤权后该信号降至 −125.68 dB，程序声音保持。Example、模拟器及临时信任已回收。当前现场 SCM 仍运行 `53c7385a`。[最新版 Win11 音频、安装与回滚证据](evidence/windows11-android-packaged-audio-d0a5b4c8-20261127.json)

同源 Ubuntu 安装器的真实网卡换址联验通过。两个 HTTPS 入口在 2.739 秒内加载新证书，原固定观看链接在未重载页面的情况下恢复直连媒体，新连接观测到 49 帧视频和 81 个音频包。运行进程、CA 和私钥保持，Sunshine 完成自动配对。现场 Win11 网络与实体设备另有验收边界。[同源换址联验](https://github.com/bei612/stream-kit/actions/runs/45994240668)

官方 Android 模拟器用同源 Ubuntu 安装器和签名 APK `1000027` 完成覆盖升级。原 `v0.1.0` 书签可直接打开，Android 与 Web 使用同一上游，真实目标输入交接、Android 前后台恢复、麦克风系统授权拒绝和客户端断网重连均通过。[同源 Android 与 Web 联验](https://github.com/bei612/stream-kit/actions/runs/45995324077)

完成同源依赖复核。Windows 安装器中的原生控制服务二进制符号扫描未发现已知漏洞，媒体网页运行依赖和 APK 的 15 个 Maven 坐标无命中。管理页 React Router 的 10 条已知公告逐条复核仍无适用调用路径，其锁定版本仍在公告范围内。Windows 和 Ubuntu 原生网关图中检出的 Rust 公告已按平台、编译功能与入口核对，详细边界及源码 SBOM 校验值见证据。[候选依赖复核](evidence/windows11-runtime-dependency-review-d0a5b4c8-20261127.json)

上一候选 `e253605d02e0fa686faeb76704fd966e8a3179d5` 的精确 Windows 安装器在独立 Windows Server 2022 通过静默安装、原生录音、服务恢复和卸载数据保留。SCM 为 Auto / LocalSystem，采集 144,000 帧，零丢帧和缓冲异常，系统既有默认录放设备保持。安装和卸载退出码均为 0。[原始安装验收](https://github.com/bei612/stream-kit/actions/runs/45993320089)

Win11 独立实例以同包三组件、签名 APK `1000026` 和 Example 通过实际媒体联验。Android 和 Web 共享一个上游、均收到程序声音；Android 的授权麦克风送达 Windows 目标录音与 Web 观众，目标录音零丢帧。持续向模拟器注入测试音时撤权，Web 的麦克风信号由 −39.67 dB 降至 −126.07 dB，程序声音保持，Example、模拟器及临时信任已清理。[Win11 同包音频证据](evidence/windows11-android-packaged-audio-e253605d-20261127.json)

该候选的 Linux 隔离联验使用实际网卡换址并自动配对 Sunshine。两个 HTTPS 入口在 10.625 秒内更换证书，HTTP/1.1 和 HTTP/2 均验证通过，浏览器在原页面恢复到新直连地址。CA、私钥、运行配置和三个进程保持。Android `v0.1.0` 覆盖升级至同源 `1000026` 后保留书签，Android 和 Web 共享一个上游，输入交接及撤权、前后台恢复、Android 麦克风权限拒绝和客户端断网重连均通过。该联验范围是隔离 Linux 和官方 Android 模拟器。[LAN 联验](https://github.com/bei612/stream-kit/actions/runs/45990406636) · [Android 联验](https://github.com/bei612/stream-kit/actions/runs/45990418488)

主线进一步处理了 Windows 自启动时的桌面会话切换。若 Windows 已列出活动会话、用户令牌暂时尚未就绪，组件沿用已有登录等待流程；已核实的指定会话仍优先。其他会话可能造成归属不明确时继续等待，权限错误仍明确报错。Windows 组件和控制服务测试通过；真实整机重启仍需独立验收。[Windows 会话令牌接口](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken)

Windows 安装因本机音频类驱动返回 `3010` 时，当前代码在自动启动阶段辨别指定 USB 音频设备的准备状态。源接口策略已写入时，通过 Core Audio 读取同一 PnP 容器的一对活动录放端点，确认防止抢占默认音频设备的策略已生效后完成准备；策略尚未生效时仍由系统执行原有的设备刷新流程。Windows 明确报告设备待重启时保留 `3010`。当前 Win11 对已安装设备的只读检查确认两个端点均为有效策略 `0x107`，无关容器不能通过。安装返回 `3010` 后整机重启的闭环仍待验收。[Windows 端点策略](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/pkey-audiodevice-neversetasdefaultendpoint)

Windows 维护工具预检查询正在上传或解压的归档。回滚先核对原运行库存和数据库冷备份，恢复服务后重新核对应用 ID、配置、CA 和私钥。Windows 原生 SQLite 文件测试验证原应用恢复及损坏备份在替换数据库前被拒绝。独立 Windows 安装验收已接入真实端口冲突触发候选服务启动失败的回滚路径，验收使用两个同仓冻结产物。实际 Win11 SCM 维护回滚另行验收。[维护操作说明](../deploy/README.md#更新与卸载)

主线已将原生网关和 Moonlight 绑定的 `crossbeam-epoch` 锁定到 0.9.21，原生和 Web/WASM 的 RSA 配对后端统一锁定到 0.10.0。Windows 原生 Rust 及 Web/WASM 锁定编译检查通过。OpenSSL 生成的既有格式证书和 PKCS#8 私钥可由新后端读取，新生成的证书和配对签名也经 OpenSSL 交叉验证。`d0a5b4c8` 的 Ubuntu 安装包在实际换址测试中完成 Sunshine 自动配对。下文 `55d6d5a8` 候选使用更新前的依赖。[Crossbeam 公告](https://rustsec.org/advisories/RUSTSEC-2026-0204.html) · [RSA 公告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)

主线网关的 Windows 和 Linux 生产依赖都已改用 `h2 0.4.21`。Windows 独立 Actix 服务验证了实际 HTTP/1.1 请求、HTTP/2 并发 HEAD 与 1 MiB POST、authority 和重复响应头。`d0a5b4c8` 的 Ubuntu 安装包通过两种 HTTP 版本和换址后的浏览器串流检查，Win11 同包载荷通过受信 HTTPS 的 Android 和 Web 观看联验。[依赖来源](../third_party-manifests/actix-http.json) · [RustSec 公告](https://rustsec.org/advisories/RUSTSEC-2026-0258.html)

上一候选 `55d6d5a8a85db6b0b9a5cefb4afa042305b8fd49` 修复了管理服务对本机 HTTPS 媒体网关的信任。Win11 已用独立 CA 对照运行两版管理服务。旧版签名设备查询和配置读取均返回 503，修复版均返回 200，组件健康状态进入 `running`。同一 CA 签发的新证书在 3.984 秒内被网关热加载，进程 PID 保持，签名查询继续成功。该复核使用前一候选的同源码网关，Windows 信任库与现有部署保持原状。[Win11 原生复核](evidence/windows11-managed-gateway-ca-55d6d5a8-20261127.json)

签名 Android APK（`1000025`）已下载并核对 21 项文件、发行签名 v2/v3 和包内源码标记，SHA-256 为 `42f5ec53825742e9e3cc36cb071351debc671b1eb6d618a2a5b4f76ce923a717`。同源 Ubuntu 安装包已通过原生初始化并下载校验，大小 62,809,265 字节，SHA-256 为 `baf0013d65e8c7ab5a1bae564165e7ea61093405bc4af784397c354753f1e415`。同源 Windows EXE 已下载，大小 98,063,895 字节，SHA-256 为 `39d7f383794ad51cd359925b22340c466f88e34b382b998d0c84922a8f9b9116`，安装器清单与原生三组件载荷清单一致。[Android 签名构建](https://github.com/bei612/stream-kit/actions/runs/45975421542) · [服务端构建](https://github.com/bei612/stream-kit/actions/runs/45975421507)

该 Ubuntu 安装包的实际换址联验通过。原固定观看链接随发现记录指向新地址，两套 HTTPS 入口在 7.067 秒内更新证书并移除旧地址，HTTP/1.1 和 HTTP/2 均通过校验。原浏览器页面无须重载即转到新的直连 IPv4，恢复 48 帧视频和 79 个音频包。CA、私钥、应用配置和进程保持。现场 Windows 换址及 Android 音频继续使用独立验收。[同源实际换址联验](https://github.com/bei612/stream-kit/actions/runs/45977721472)

正式 Android `v0.1.0` 直接覆盖升级至候选 `1000025` 已通过。原书签可打开，客户端以观看者身份入场且麦克风关闭。Android 和 Web 轮流获得控制权，六个阶段核对了目标按键、点击及旧控制者撤权。[同源覆盖升级与输入联验](https://github.com/bei612/stream-kit/actions/runs/45977721103)

Win11 使用同源三组件载荷和签名 APK 完成了 Android、目标录音和 Web 音频联验。Android 与 Web 共享一条渲染上游，程序声持续播放。撤权后，持续注入的麦克风测试信号在 Web 端从 −22.11 dB 降至 −127.28 dB，目标录音峰值低于 0.000001，录音无丢帧。独立模拟器和临时信任已回收。[Win11 同源音频证据](evidence/windows11-android-packaged-audio-55d6d5a8-20261127.json)

同一 EXE 在 Windows Server 2022 托管安装验收中返回 `3010`。SetupAPI 记录了应用虚拟 USB 音频的端点策略时，设备句柄阻止了类驱动刷新。Windows 因此要求重启，服务启动和 PCM 环节未执行。卸载成功并保留了应用数据。随后验证了只重新挂载设备的方案。原生录音收到 144,000 帧且零丢帧，但虚拟设备抢占了系统默认输出，主线已撤回该方案。完整安装和重启后的自启动仍需验证。[托管安装验收](https://github.com/bei612/stream-kit/actions/runs/45984473224) · [独立端点复核](https://github.com/bei612/stream-kit/actions/runs/45985744990)

上一发布候选冻结于 `ce49050f4dfcbd1e22d9d4f22093f6b965e6aac8`，含固定观看主机名与大型归档限额界面。[Windows 统一安装器](https://github.com/bei612/stream-kit/actions/runs/45939440963)已构建，大小 98,055,882 字节，SHA-256 为 `9ab0b300106e748fd21b62e5521c8dfe2c280cd252eed80d117844bc4f07fd8f`，原包与三组件清单均已核验。[Android 原生 APK](https://github.com/bei612/stream-kit/actions/runs/45939467986)的 versionCode 为 `1000024`，本地验证了 21 项文件和 v2/v3 发行签名，APK SHA-256 为 `f65455f6d07c7b66d14d86f51ed076cfea5e75a34c6693ede87697d996d6a0b7`。

同一 Windows 安装器在 [Windows Server 2022 CI](https://github.com/bei612/stream-kit/actions/runs/45943221270)通过静默安装、自启动配置、144,000 帧原生音频、网关和 SCM 服务恢复、卸载及数据保留。Win11 独立实例使用同包原生三组件验证了两个 Web 观众的应用画面和程序音，Example 正常停止。Playwright CLI 通过了同包管理页桌面和手机布局、上传限额、永久链接启用、轮换和关闭。[Android 与 Web 输入联验](https://github.com/bei612/stream-kit/actions/runs/45943466475)通过同源共享上游、触摸及按键交接、两类旧控制者撤权。证据和适用环境见[候选产物验收](evidence/windows-android-ce49050f-candidate-20261127.json)。本机更新的管理员启动命令被工具自动审批拒绝，现有 Windows 服务仍运行 `53c7385a`。

使用该源码的[隔离 Linux 安装器](https://github.com/bei612/stream-kit/actions/runs/45939312965)实际运行并通过[固定观看主机名换址验收](https://github.com/bei612/stream-kit/actions/runs/45941800647)。同一个浏览器页面和书签在换址后自动恢复画面与音频数据包，HTTPS 身份约 13.54 秒内更新，配置、CA 和私钥保持。换址前后各只有当时唯一的新旧 LAN 地址作为 UDP 主机候选。本机 Windows 和实体 Android 的联合现场换址继续使用独立证据。

本机已安装并验收的 `0.1.1` 候选源码为 `53c7385ac58d39408a3aaffef33d6a95ea06a737`。该源码包含归档上传空闲超时、直接落盘、媒体网关和解压依赖更新，以及 Go 1.27.4 工具链与 quic-go 补丁。Windows 11 原生 Go 定向测试通过，管理服务符号级扫描未发现已知漏洞。候选产物来自 [Windows 单安装器构建](https://github.com/bei612/stream-kit/actions/runs/45798220979)及 [Android 签名构建](https://github.com/bei612/stream-kit/actions/runs/45798220812)，Android versionCode 为 1000021。详见[工具链与依赖复核](evidence/windows11-runtime-dependency-review-53c7385a.json)。

上一候选 `324106b01312c722db82d922953d7588b0581a76` 首次将受管 WebRTC 会话的媒体 UDP 绑定到信令连接的实际 IPv4 地址，并包含应用详情语言修复。[Android APK](https://github.com/bei612/stream-kit/actions/runs/45933665875) 的 versionCode 为 `1000023`，本地核对了 21 项产物清单、APK 签名 v2/v3 和应用 ID，APK SHA-256 为 `fbc907d3ad317b7472b129a196e485348b5222a30b4f0fae8de2f8de0dc9dc8e`。[同源 Linux 安装器](https://github.com/bei612/stream-kit/actions/runs/45933396003)通过原生安装检查。[跨平台构建的 Windows 网关](https://github.com/bei612/stream-kit/actions/runs/45933396105/artifacts/15170067547)在本机通过 35 项文件核验及 30 项原生配置检查。[旧候选 Windows 安装器](https://github.com/bei612/stream-kit/actions/runs/45933668313)作为旧候选构建证据，本机部署仍运行 `53c7385a`。

Android 联验和隔离 LAN 换址验收可显式选择 Linux 安装器的构建工作流。两类验收直接消费固定构建的安装器并记录来源，Android 候选联验还会要求 APK 与安装器的源码提交完全相同。本候选已进入 [LAN 换址与媒体候选](https://github.com/bei612/stream-kit/actions/runs/45935146775)、[Android 与 Web 输入](https://github.com/bei612/stream-kit/actions/runs/45935149788)和 [Android 与 Web 音频](https://github.com/bei612/stream-kit/actions/runs/45935153698)实际联验。

候选的隔离 LAN 换址联验通过。两个 HTTPS 入口在 10.25 秒内更换服务证书，保留 CA 和私钥。原浏览器页面自动恢复串流，换址前后只收到当前直连地址的 UDP 主机候选。Android 与 Web 使用同一上游，双方实测轮流向目标交付按键及触摸，交接和撤权后的输入保持被拒绝。Linux 模拟器音频联验的独立系统音基线未通过。修复探针状态读取与 PCM 写入的争用后，已采到 194739 帧且探针丢帧为零，基准音仍近静音，产品音频测试未进入。见[音频探针修复后的联验](https://github.com/bei612/stream-kit/actions/runs/45936840917)。

同源 Ubuntu 24.04 amd64 正式候选安装器已构建并通过原生初始化。已下载并核验 Windows 与 Ubuntu 安装器的源码、渠道、版本及二进制摘要。Ubuntu 安装包为 62,815,341 字节，SHA-256 为 `3de5c78de83177d6768932cc779bb3f6b0e2ceec2138903955287682483a781d`，可与 Windows 和 Android 同批发布。[Ubuntu 0.1.1 构建及初始化](https://github.com/bei612/stream-kit/actions/runs/45970565029)

Win11 独立实例以原生 HTTP 客户端及 Playwright CLI 驱动的 Chrome 分别上传并解压实际 26 GiB TAR。随后以 `ce49050f` 候选安装包的原生管理服务接收 27,921,765,888 字节，实际解压 27,921,762,816 字节，应用进入就绪状态、Example 哈希一致、暂存及应用测试目录均已回收。该候选管理页的桌面和窄屏限额显示已验收。主线沿用这套上传、解压和管理页实现。[候选包大文件验收](evidence/windows-android-ce49050f-candidate-20261127.json) · [浏览器应用就绪截图](evidence/windows11-browser-upload-26gib-20261127.png)

主线 `666a6a01` 加入暂存、应用目录可用空间显示以及默认 1 GiB 的可配置磁盘留量。Win11 独立实例已用新写入逻辑重新通过 26 GiB 上传与解压，Example 就绪且文件哈希一致。Playwright CLI 另验证普通 ZIP 真上传、窄屏容量提示、空间不足时禁用表单以及原生接口返回 `507` 后清理状态。[磁盘保护验收和截图](evidence/windows11-archive-space-666a6a01-20261127.json)

主线 `38552c09` 将 ZIP、ZIP64 和 7z 的条目数量检查提前至索引分配前。Win11 原生测试通过 65,536 条 ZIP64 的边界、26 GiB 逻辑偏移读取及普通和压缩 7z 头的数量限制。Playwright CLI 在独立服务上验证 Example ZIP/7z 进入就绪，条目超限时详情页显示原因且提取字节为零。此记录对应主线源码的独立运行。公开安装包仍见本页顶部的发布信息。[索引边界验收](evidence/windows11-archive-index-38552c09-20261127.json)

本机已安装的 `53c7385a` 支持流式落盘和空闲超时，上传及解压上限默认各 50 GiB。公开发行的 `v0.1.0` 浏览器端仍使用 30 分钟总时限。导入大包时，应根据实际压缩包和解压大小为两个目录预留空间。两目录同卷时需要同时容纳两份数据。[存储部署说明](../deploy/windows/README.md#静默与向导)

同源签名 APK 的前后台恢复已在官方 Android 36 模拟器通过。Android 持有控制权时退出到桌面，服务释放该连接及控制权；回前台以全新观看连接恢复原串流，麦克风保持关闭。客户端恢复后观察到 300 个音频包和 115 帧解码画面，Web 继续共享同一渲染实例。[实际前后台联验](https://github.com/bei612/stream-kit/actions/runs/45948972310)

正式 Android `v0.1.0`（1000015）覆盖升级至当前签名候选（1000024）通过。升级后首次安装身份保留，从普通入口使用原书签即可入场，无需再次导入。客户端以观看者入场且麦克风保持关闭，随后通过实际输入和前后台恢复联验。[升级证据](evidence/android-upgrade-ce49050f-20261127.json) · [实际升级联验](https://github.com/bei612/stream-kit/actions/runs/45950069635)

官方 Android 36 模拟器断网联验通过。模拟器断网约 15.1 秒后控制权随租约过期，Web 同一渲染实例继续运行。恢复模拟器联网后，Android 原连接自行以观看者身份恢复，麦克风关闭，实际恢复 305 个音频包和 108 帧解码画面。该结果覆盖 Android 客户端断网重连，现场 Win11 宿主机换址需要独立联验。[实际断网恢复记录](https://github.com/bei612/stream-kit/actions/runs/45950890473)

同源签名 APK 已通过 Android 系统麦克风授权拒绝实测。用户在系统弹窗选择拒绝后，系统保留拒绝决定，客户端继续持有控制权，服务端麦克风保持关闭。随后断网恢复联验也通过。该证据覆盖拒绝分支，允许后的声音回传继续单独验收。[系统权限联验](https://github.com/bei612/stream-kit/actions/runs/45957769418)

同源 Android 音频已走到实际采集测量。原生页面开启麦克风，服务确认采集状态，工具向官方 AVD 接口提交了 253 个合成音包，同时观察 Web 与目标录音。目标分析 240,000 帧且零探针丢帧，但 1499 Hz 幅度未达标，Web 同期也低于门槛。独立系统播放基线同样未通过，尚需确认合成声源是否真正到达 Android 本地采集，以及发布候选的完整音频链路。此轮未执行到音频撤权测量。[同源音频原始结果](https://github.com/bei612/stream-kit/actions/runs/45950448625)

Linux 官方 Android Emulator `37.3.10` 的独立前台 AudioRecord 复核确认，合成注入 RPC 成功结束，探针录得完整 240,000 帧，系统未标记客户端静音，但 1499 Hz 在所有窗口中均未达到阈值，中位强度为 0。该轮同源产品音频判定保持失败，已经定位到模拟器本地声源验证失败，产品的麦克风回传仍需在可验证的输入环境补验。[独立采集基线](https://github.com/bei612/stream-kit/actions/runs/45952589388)

官方 Linux 模拟器 `37.2.13` 使用相同 Android 36 镜像和验收阈值，有一次通过独立系统播放基准，分析 192,000 帧并检出两组基准频率。加采录音进度后再次执行，系统播放未通过，录音在半程采样前停住。两次均未进入产品音频阶段，目前无法把差异归因于模拟器版本。[首次版本对照](https://github.com/bei612/stream-kit/actions/runs/45954552924) · [采集进度对照](https://github.com/bei612/stream-kit/actions/runs/45956151212)

以独立 PulseAudio 虚拟监听源供音，已经核对模拟器实际读取、独立探针退出和路由恢复。前台录音 240,000 帧中有 5/50 个窗口检出足够强的测试音，中位值为零。该次独立系统播放通过，但签名候选产品的 Android 播放以及目标录音和 Web 回传仍未通过。[独立虚拟音源联验](https://github.com/bei612/stream-kit/actions/runs/45960235877)

追加宿主监听已证实同一个虚拟源的输入连续存在，宿主端 30/30 个窗口达标，中位振幅 0.126。Android 36 前台独立录音同步采到 240,000 帧，但只有 7/50 个窗口达标。观测到的持续性丢失位于宿主 PulseAudio 源和 Android 本地采集之间，尚未形成该环境的产品回传通过证据。[宿主和 Android 同步测量](https://github.com/bei612/stream-kit/actions/runs/45961647160)

Android 35 同配置复核同样得到宿主监听 30/30 达标，但 Android 本地录音为 0/50。独立录音释放、进程退出和路由恢复已确认。候选 APK 随后完成麦克风开启，独立宿主监听仍为 30/30，Web 回传门槛未通过。两种系统镜像均无法用该 Linux 模拟器环境证明持续麦克风输入。[Android 35 对照记录](https://github.com/bei612/stream-kit/actions/runs/45962603010)

Windows 11 上，官方模拟器 37.2.13 在注入合成音时发生 QEMU 访问冲突。独立验证改用 Google 签名的 37.3.10 稳定版后，Android 36 录满 240,000 帧，50/50 个窗口达标，录音和探针正常释放。同版本 Linux CI 的虚拟监听仍有 30/30 个输入窗口达标，Android 独立采集仅 3/50，候选 APK 的 Web 回传未通过。Windows 上校准通过的声源仍需与候选 APK、目标录音端点和 Web 观众联验。[Windows 模拟器采集记录](evidence/windows-android-ce49050f-candidate-20261127.json) · [Linux 同版对照](https://github.com/bei612/stream-kit/actions/runs/45969071362)

Windows 11 全新临时 Android 36 AVD 以首批 PCM 为就绪点启动输入后，独立采集的 50 个窗口全部达标。已在同一实例安装原样签名的 `0.1.1`（`1000024`），核对安装后 APK 摘要并清理临时 AVD。该次操作没有打开观看链接，音频回传仍需单独联验。[签名安装证据](evidence/windows-android-ce49050f-candidate-20261127.json)

本机旧部署的固定主机名 `volcengine.local` 已用同机 Playwright CLI 验证原 CA 下的管理入口、网关和 Example 永久链接，共解码 37 帧，随后正常停止 Example。记录只覆盖本机固定主机名入口。实体 Android 对该名字和换址后串流的现场确认另行记录。

本机 Windows 三个运行组件及实体平板已更新至候选 `53c7385a`，保持原应用、CA、配置与平板书签。单安装器、静默安装、服务自动恢复和卸载已经在 Windows Server 2022 CI 通过。实装 Win11 与平板、Web 的共享画面、程序音、控制权交接及平板麦克风至目标录音端点和 Web 观众均已验证。当前仍需独立 Win11 首装与实际回退、现场 LAN 换址、完整输入撤权验收和依赖剩余项处理。见[同源实装与联验](evidence/windows11-android-joint-53c7385a.json)、[安装器验收](https://github.com/bei612/stream-kit/actions/runs/45806470686)。

2026-11-27 已实测 `53c7385a` 整机重启。控制服务在开机后 14.42 秒启动，Sunshine 和媒体网关随桌面会话在约 31 秒启动，均未手工启动。WLAN 由 `192.168.0.119` 变为 `192.168.2.131`，管理与媒体 HTTPS 在原 CA 下通过。原永久链接只换主机地址即可唤起 Example，同机浏览器实际选用了隧道候选。两个普通 Web 客户端的真实键盘交接和撤权通过，观察到两位控制者依次使目标计数增加，转交后及撤权后计数均保持。实体平板在新 WLAN 上对主机的邻居解析失败，跨机媒体待验收。见[Win11 重启与实际换址](evidence/windows11-reboot-and-lan-53c7385a-20261127.json)。

初始候选 `1fa79664` 的 Windows 11 隔离管理页已通过 ZIP、7z 和本机路径登记；最终安装候选的管理子包已在 Win11 隔离页面复核 7z。签名覆盖升级和书签校验保留各自实测版本。见[初始候选验收](evidence/windows11-android-candidate-1fa79664.json)、[签名候选平板覆盖安装](evidence/windows11-android-tablet-upgrade-53c7385a.json)。

候选冻结后，源码 `e55bd5ec` 修正应用详情的固定观看链接和采集能力状态中英文混用。Windows 隔离页面验收已覆盖两种语言与链接启用、重置、关闭。该页面修复待随下一个完整同源安装包部署。见[应用详情语言核验](evidence/app-detail-localization-e55bd5ec.json)。

实体 Android 平板的目标输入缺口现已补齐：[实际输入与控制交接验收](evidence/android-input-tablet-954a1e6e-20261126.json)使用已安装的 `954a1e6e` 原生 APK、同源 Windows 服务和 Playwright CLI 管理页。Example 实际按键/点击计数在平板授权后由 5/6 增至 6/7；移交给 Web、交回 Android 和释放控制后，旧控制端的输入均未改变目标计数。原加密书签完整恢复，临时工具已卸载，Example 停止且无活动测试会话。本次不修改生产源码、不重新构建或安装；整机重启、首次安装返回 3010 后的重启路径及本机主网卡真实换址仍未完成验收。

源码 `954a1e6e` 新增共用概念气泡的视口避让和生命周期修复：原安装版手机宽度 390px 时隐藏气泡撑至 639px，已在实际安装页面复现。新同源产物现已完整安装；Playwright CLI 对实际安装页面的 8 路由 × 3 宽度及中英文气泡检查通过，四张截图已目视复核。键盘、触屏、配置冲突和组件启停另有同源 CI 证据。详见[已安装验收](evidence/runtime-installed-954a1e6e-20261120.json)和[修复审查](evidence/management-tooltip-review-20261119.json)。运行依赖审查发现一个 React Router 告警包；[逐公告适用性核查](evidence/management-dependency-review-20261119.json)未发现当前调用方式暴露所列攻击路径，包仍未升级，不声明扫描清零。

历史 Win11 维护 `954a1e6e73ef95231e78c9d77d77d932749aa043` 保留本轮回退副本，三组件库存已验证。该版本的管理端资源为 `index-DkDzwuSd.js` / `index-BQYlHHxO.css`。当时服务为 Auto / LocalSystem / Running，两个子组件均 running、崩溃计数 0，原配置、信任和应用身份保留。见[954a1e6e 安装与页面验收](evidence/runtime-installed-954a1e6e-20261120.json)。

此前预发布运行源码冻结为 `954a1e6e73ef95231e78c9d77d77d932749aa043`，沿用局域网地址自动识别、双入口证书热更新及 OpenSSL 4.1 兼容，并修复概念气泡布局。[v0.1.0-preview.20261119.3](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.3) 已公开 Windows/Linux 安装器、Android APK 及配套材料。首次部署该预发布时，本机三组件与平板同源。14 个附件的字节数和 GitHub 存储摘要已与已验证产物核对，其中 Windows 安装器及六份材料完成匿名全量下载。其余大文件复用先前构建附件校验。详见[发布证据](evidence/release-preview-20261119.3.json)。历史维护失败、回滚和重启要求分别保留原始记录。

自动换址已通过[真实隔离网络验证](evidence/lan-autodiscovery-515b9918-20261119.json)：移除旧 IP 并新增 IP 后，6.93 秒内两个 HTTPS 入口更新身份，CA、私钥、配置与进程保持，WebRTC 自动恢复到新媒体地址。该实验实际运行 `515b9918`；其管理端和网关源码与 `1d81a373` 完全一致，记录仍保留原始运行身份。本页下方手动地址恢复记录证明的是更新前的本机状态。

## 当前版本

| 对象 | 版本 / 来源 | 状态 |
| --- | --- | --- |
| 公开 Windows / Ubuntu 24.04 amd64 服务端 | [v0.1.0](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，`f8ede8b2e933fb597e97dec999cceae9a3e614e1` | 11 月 15 日正式版，每平台一个安装器；不含本次自动换址功能 |
| 公开签名 Android | [v0.1.0 同一 Release](https://github.com/bei612/stream-kit/releases/tag/v0.1.0)，同源 `f8ede8b2`，versionCode 1000015 | 已公开 APK、来源、校验和、依赖许可证和 SBOM，沿用持久发行签名 |
| 本机运行组件及前端 | `53c7385ac58d39408a3aaffef33d6a95ea06a737` | 三组件及管理前端完整维护，保留原安装器、卸载器和签名驱动。库存、共享流、程序音及平板麦克风通过 [现场验收](evidence/windows11-android-joint-53c7385a.json) |
| 最新公开预发布服务端 / Android | [v0.1.1-rc.1](https://github.com/bei612/stream-kit/releases/tag/v0.1.1-rc.1)，`d0a5b4c8` | Windows 和 Ubuntu 24.04 amd64 单文件安装器、持久签名 APK `1000027`，14 个附件校验通过 |
| 本机平板 Android | 0.1.1 候选 / versionCode 1000021，`53c7385a` | [签名与覆盖安装](evidence/windows11-android-tablet-upgrade-53c7385a.json)及[同源视频、程序音、按键和麦克风联验](evidence/windows11-android-joint-53c7385a.json)通过。上一版完整输入证据见[954a1e6e 原始实测](evidence/android-input-tablet-954a1e6e-20261126.json) |
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
| 最新实体平板目标输入 | [954a1e6e 输入补验](evidence/android-input-tablet-954a1e6e-20261126.json)：实际原生平板与 Web 共用一个 Example 上游，平板按键及触屏点击到达目标窗口；Playwright CLI 在已安装管理页完成双向移交和释放，旧控制端输入无效。九张实际截图已复核；原书签恢复、临时工具卸载、会话停止。使用 ADB 生成设备输入事件，不代表真人触屏操作或本轮音频复验 |
| Android 实体平板定向验收 | [1d81a373 真机记录](evidence/android-tablet-1d81a373-20261119.json)：原生永久入口启动 Example，初始实际解码 90 帧，Android 与 Web 共用一上游；管理页转交控制后平板变旁观者并停止录音。切后台释放 Android 连接，Web 保持；回前台重新解码、以旁观者加入且未自动录音。原加密书签恢复摘要一致，两个 testOnly 辅助 APK 已卸载，全部测试会话已停止。目标输入失败/音频未验收和辅助工具失败如实保留 |
| Android 实体平板音频补验 | [同源真机音频](evidence/android-tablet-audio-1d81a373-20261119.json)：临时显式配置现有项目虚拟端点，程序音使 Android 解码累计能量升至 0.0807；实际平板麦克风到服务器录音端点的最大 RMS 由 0.0000154 升至 0.00497，撤权后为 0.0000156；Web 观众最大 RMS 为 0 → 0.0435 → 0。未要求讲话、不保存 PCM，不代表声学音质或语音可懂度验收；网关少量丢帧和客户端补偿样本保留。Example 参数、会话路由、原书签均恢复，辅助工具卸载，零活动测试会话 |
| 本机最新同源运行与页面 | [954a1e6e 已安装验收](evidence/runtime-installed-954a1e6e-20261120.json)：完整三组件库存与服务恢复、配置和信任保留、双管理入口可信 HTTPS、8 路由 × 3 宽度和中英文气泡通过，4 张截图目视通过，页面异常为 0。此前 [1d81a373 媒体与操作检查](evidence/runtime-installed-1d81a373-20261119.json)保留永久链接启动 Example、双 Web 控制交接、停止后编辑与退出等证据；本次未重跑媒体或启动 UE |
| 自动识别地址与双入口热更新 | [真实隔离迁移](evidence/lan-autodiscovery-515b9918-20261119.json)：新 IP 的原 CA 校验、旧 SAN 移除、三进程/配置/私钥保持及 WebRTC 新地址恢复通过；首次脚本权限失败及修复单独保留，不等同于本机 Windows/Android 真机迁移 |
| 服务端持续资源上限与释放 | [资源审查](evidence/runtime-resource-review-20261113.json)：帧元数据、握手失败连接、媒体队列、缓存、HTTP 响应和日志清理，已纳入本机及候选；资源所有权见[运行资源](runtime-resources.md) |
| 控制请求和操作锁 | [生产复审](evidence/production-readiness-review-20261114.json)：控制体统一 1 MiB，固定长度/chunked 超限返回 413，上传保留独立预算；锁仅保留活动所有者，20,000 次完成后归零 |
| 浏览器帧生命周期 | Canvas reader 取消、finally 释放、迟到帧关闭；原生 Chrome 100 次换轨/关闭及异常分支通过，MSE/WebCodecs 原生检查通过，已纳入本机和候选 |
| 本机实际 UI / 循环 | [ce52bdac 验收](evidence/runtime-installed-ce52bdac-20261114.json)：严格 HTTPS、永久入口启动 Example、双端 1920×1080、唯一控制授予/交接/撤销、断开隔离、停止后可编辑；100 次真实进入/解码/工具栏退出，各批恢复单连接，无页面异常 |
| 默认 H.264 混合连接 | ce52 Web 先入声明 High 4:4:4，Android 后入被拒。f8ede8b2 将两端默认统一为普通 H.264 掩码 0x0001，高阶格式仍可显式选择实验性 auto；[新本机联合回归](evidence/runtime-installed-f8ede8b2-20261115.json)证明 Web 先启动、Android 后加入，同一会话持续解码，实际 H.264 profile-level-id=64001f |
| 精确 Windows 安装器 | [f8ede8b2 安装验收](evidence/windows-installer-f8ede8b2-20261114.json)：原始字节静默安装、自启动、网关恢复、SCM 重启、144000 帧原生录音、卸载及数据保留通过；不代替本机维护或整机重启 |
| 实际资源观察 | [ce52bdac 原始计数](evidence/runtime-resources-ce52bdac-20261114.json)：45.64 分钟混合负载采样未含 SCM 主服务；补充 14.51 分钟已预热单观看端完整采样，主服务 64.63→64.28 MiB、网关 19.99→20.00 MiB、浏览器进程合计 566.26→581.92 MiB，句柄未持续累积。为部署已就绪的新包提前结束窗口；不标成计划时长完成，不推断长期无泄漏 |
| 正式 0.1.0 Linux 实际页面 | [f8ede8b2 页面验收](evidence/management-live-f8ede8b2-20261114.json)：原始统一包、可信 HTTPS、真实双 WebRTC 解码、唯一控制交接、参数保存恢复及桌面/手机截图；不含 Android 音频或长跑 |
| Windows Android / Web 音频 | [ce52 音频验收](evidence/android-audio-windows-ce52bdac-20261114.json)：Android 程序音 239999 帧 / 49 窗口，Web 程序音、合成麦克风到真实录音端点和观众、撤权静音通过。采用 Android 先入，仅证明音频链路；参数、路由、音量均恢复，无保存 PCM |
| 新本机同源联合验收 | [f8ede8b2 实际运行](evidence/runtime-installed-f8ede8b2-20261115.json)：Web 先入；Android 程序音 49/49 窗口、Web 程序音通过，Android 合成麦克风到原生录音端点及 Web 观众，撤权后两端静音、零采集丢帧；停止后零活动会话/连接/媒体观测。测试参数、路由和音量恢复，模拟器已停止，服务 Auto/LocalSystem/Running |
| 原生输入和独立地址恢复 | [输入六阶段](evidence/android-input-db01e6c6-20261114.json)、[独立 Linux 网卡迁移](evidence/lan-address-recovery-db01e6c6-20261114.json)保留实际来源，不代替本机 Windows 主网卡或新 APK 验收 |
| 管理端统一布局 | [布局与交互](evidence/management-layout-a616beba.json)：8 路由共用容器/栅格/导航，覆盖手机、平板、桌面、草稿保留与冲突；新候选实际页面另见上行，维护契约见[管理布局](management-layout.md) |

检查使用独立 Example、外部采样器和专用模拟器，不进入生产安装包或 APK。不启动或修改其他代理维护的 UE，不修改 ToDesk、宿主机默认音频或客户端信任来绕过问题。

## 交付结果

历史预发布 [v0.1.0-preview.20261119.3](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.3) 通过[原产物发布任务](https://github.com/bei612/stream-kit/actions/runs/44569208733)公开，未重新编译。Windows 安装器为 `stream-kit-preview-954a1e6e73ef-windows-amd64-setup.exe`，98,019,654 字节，SHA-256 `5b5bf5a5f8795fa5b524aefaf773cf395faff61128fbe58cfd8e8e8486e80e01`；已完成公开匿名下载并与[实际安装验收](evidence/windows-installer-954a1e6e-20261120.json)逐字节身份核对。该独立环境中原生录音捕获 144,000 帧，零丢帧/缓冲异常、网关及自动服务恢复、卸载及数据保留通过。此前环境返回 `3010` 的结果仍保留，不代表该环境已完成重启后验收。Android 为持久签名 versionCode 1000018；Linux 安装器来源及初始化边界见[Linux 产物证据](evidence/linux-installer-954a1e6e-20261120.json)。完整附件及下载核对范围见[发布证据](evidence/release-preview-20261119.3.json)。

上一预发布 [v0.1.0-preview.20261119.2](https://github.com/bei612/stream-kit/releases/tag/v0.1.0-preview.20261119.2) 的 14 个附件全量下载、旧本机同源维护及其网络失败记录保留在[历史发布证据](evidence/release-preview-20261119.2.json)及上方原始验收中，不作为最新安装状态。

正式 0.1.0 的 Windows/Linux 安装器、Android APK、源码 tag、校验和及许可证材料已发布；其本机完整组件维护与联合回归保留原始证据。资源采样已收齐，不重复未受影响的四小时或 100 次循环。原完整跨平台 CI 六项已通过；一次 Ubuntu 任务因官方 Chrome 下载的 HTTP/2 中断重试，只重跑失败任务，未重建原冻结产品。公开附件与实际下载核验见[0.1.0 发布证据](evidence/release-0.1.0-20261115.json)。

已公开的上一预发布 Windows 安装器为 `stream-kit-preview-1d81a373ac29-windows-amd64-setup.exe`，97,995,563 字节，SHA-256 `568a2cd5736582a721f26a00a329e40909e4123327b1432b07b8d4669579a562`。[同一字节安装验收](evidence/windows-installer-1d81a373-20261119.json)已通过：安装/卸载退出码 0、真实 PCM 144,480 帧且零丢帧/缓冲异常、网关与 Auto / LocalSystem 服务重启恢复、默认设备和数据保留均通过。未重新构建产物。

此前[首次全新安装](https://github.com/bei612/stream-kit/actions/runs/44517278501)安装成功但返回原生驱动要求重启的 `3010`，其 PCM 和服务生命周期检查未执行；卸载和数据保留通过。该真实结果保留，后一次成功不代表所有 Windows 环境首次装驱动都无需重启。验收器补充了有界 PnP/SetupAPI 诊断，保持原通过门槛；本机维护保留已有驱动，与全新驱动安装是不同路径。

## 持续边界

- 冻结源码 `954a1e6e` 的跨平台六项、Windows/Linux 产品构建、同字节 Windows 独立安装验收、本机完整维护与页面验收均通过，已发布 `20261119.3`。首次安装的 [3010 重启要求](evidence/windows-installer-restart-954a1e6e-20261120.json)保留，尚无该次环境的重启后验证；后一次无需重启环境的成功不覆盖它。旧运行的语言选择和依赖源失败保留原记录。依赖安装报告 19 项告警（含开发依赖），运行依赖适用性见上方逐公告审查，不能声明全依赖安全审计完成。
- 当前 `53c7385a` 已验证实际 Win11 整机重启和三个组件自行恢复。首次安装返回 3010 的环境仍保留独立验收边界。
- 本机新 LAN 管理入口、自动当前 IP 身份和真实 Web 视频已通过；真实主网卡迁移后的 Windows/Android 完整媒体及输入恢复尚未验收。独立 Linux 实验不覆盖此环境。
- 平板真实目标输入已由 [11 月 26 日补验](evidence/android-input-tablet-954a1e6e-20261126.json)闭合；程序音、物理麦克风至目标端点/Web 观众及撤权静音保留 11 月 19 日证据。本次 Windows 未锁屏，最初激活辅助工具选择的窗口中心被 `mstsc` 遮挡；只对经 HWND 归属验证的 Example 可见区域执行普通点击后，平板按键与触屏输入实际到达目标。没有改动其他远程控制程序或绕过输入保护。此前 `LockApp` 是宿主机当时的观察，不是平板锁屏，也不能作为所有焦点失败的原因。原生权限标记在控制变更后曾短暂滞后，服务端已拒绝旧端输入；本次没有测量亚秒级界面更新或录音停止延迟。历史失败、零音量和旧模拟器记录保留原环境边界。
- [Linux 模拟器音频负例](evidence/android-audio-fixture-ce52bdac-20261114.json)保留；旧 APK 在该环境的近静音未解释。Windows 通过不改写其他环境的失败，也不降低采集门槛。
- 用户已接受原版本 20 客户端四小时稳定性，不重复 24 小时；真人语音保留[原始证据](evidence/human-voice-installed-20261105.json)。本轮不要求 Linux/手机真机、特定 UE 内部录音或物理设备声学验收。
- 7×24 是设计目标，目前没有新版本服务端、Web、Android 的完整 168 小时证据，不能承诺永不 OOM。修复和精确产物定向验收通过后先发布，长期运行继续跟踪；不靠定时重启或强制 GC 替代释放。
- 一台渲染主机当前同时运行一个应用串流，可供多个客户端观看；不提供多应用并行隔离。Windows 通用自动原位升级、数据库自动降级、全依赖漏洞审计及独立安全评估不在已通过范围。
