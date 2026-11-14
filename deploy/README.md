# Stream Kit 部署与运维

本手册用于长期运行维护；平台安装参数分别见 [Windows](windows/README.md) 和 [Linux](linux/INSTALL.md)。当前发布及本机组件身份集中见[发布与部署基线](../docs/release-status.md)。

## 部署组成

每个平台一个安装器，安装三个运行组件：Orchestrator、Sunshine、媒体网关及各自静态资源。Node.js/npm、编译器、SDK、Example、音频 probe、测试数据库和开发 CA 不是生产运行依赖或产品载荷。

| 平台 | 服务与进程关系 | 图形 / 音频前提 |
| --- | --- | --- |
| Windows | 一个自动 LocalSystem SCM 服务 `StreamKitOrchestrator`，管理 Sunshine 和网关两个组件工作进程 | 配置渲染用户的活动交互桌面；服务不启用系统自动登录 |
| Linux | 指定非 root 渲染用户的 `stream-kit.service`，管理同样两个组件 | 用户图形会话及 PulseAudio/PipeWire-Pulse，正确的 DISPLAY/WAYLAND 等环境 |

“一个服务、三个核心运行组件”不能混称为三个 Windows 服务。无需额外安装原版 Sunshine 服务、任务计划或启动文件夹快捷方式。系统自带音频、图形、Avahi 等服务仍属于操作系统，不由平台取代。

安装器建立启用及恢复关系。Windows 控制端可在登录前启动，但媒体采集需等待指定用户桌面；Linux 用户服务在该用户登录环境中运行。控制端在线、两个组件 running、应用开始出画面和系统重启恢复是不同事实。

## 默认地址与文件

| 项目 | Windows 默认 | Linux 默认 |
| --- | --- | --- |
| 程序目录 | `C:\Program Files\StreamKit` | `/opt/stream-kit` |
| 数据目录 | `C:\ProgramData\StreamKit` | 渲染用户 `$HOME/.local/share/stream-kit/runtime` |
| 管理入口 | `http://127.0.0.1:9000` | 同左 |
| 网关 | `http://127.0.0.1:8080` | 同左 |
| Sunshine 原生基础端口 | `47989` | 同左 |
| Sunshine 内部管理 | `https://127.0.0.1:47990` | 同左 |

这些是新安装默认值，现场配置可以覆盖端口并启用 HTTPS。已启用 HTTPS 后应使用 `https://…`；管理、网关与调用方必须一并更新。内部渲染端管理端口不应当作客户观看入口。

配置与数据库等运行数据放在外部受保护目录；不能公开原始 `orchestrator.json`，其中包含平台和内部机器间凭据。管理员密码来自安装或既有配置，没有通用默认密码。

## 日常启动、检查和停止

Windows 查询不需要修改启动关系：

```powershell
Get-Service -Name StreamKitOrchestrator
Get-CimInstance Win32_Service -Filter "Name='StreamKitOrchestrator'" |
  Select-Object State, StartMode, StartName, ProcessId
```

手动维护时在管理员 PowerShell 中使用：

```powershell
Start-Service -Name StreamKitOrchestrator
Stop-Service -Name StreamKitOrchestrator
Restart-Service -Name StreamKitOrchestrator
```

这些命令只适用于平台服务；不要重复注册子组件服务。重启会中断串流，应先从后台停止当前应用。

Linux 以配置的渲染用户执行：

```sh
systemctl --user status stream-kit.service
systemctl --user start stream-kit.service
systemctl --user stop stream-kit.service
systemctl --user restart stream-kit.service
journalctl --user -u stream-kit.service -n 100 --no-pager
```

Windows 原生部署工具可用 `orchestrator.exe service start --config ABSOLUTE_CONFIG` 等命令。它在 SCM 状态之外等待管理健康接口和自动组件就绪；普通 `Start-Service` 返回不代表画面已经可用。

## 就绪分层检查

1. 从实际协议和端口打开管理登录页；`GET /api/v1/health` 检查控制端身份及组件状态。
2. 查看组件实际 PID、启动错误及桌面会话。Sunshine 或网关未就绪时不要先重装整个平台。
3. 在后台检查应用状态、当前主机占用、运行实例和会话 overview。停止历史不是在线用户。
4. 通过应用固定观看链接进入，确认客户端实际解码、程序音和唯一权限。
5. 需要录音时单独确认当前控制者、目标端点和目标程序录音；不能只看收包或麦克风图标。

单机同一时刻一个应用串流；后台登记多个程序不表示可并行独立运行。用户关闭观看页面不等于后台应用已经停止。

## LAN、HTTPS 和地址变化

只使用本机时可保留默认 loopback HTTP。其他电脑、手机和平板使用服务器 LAN 地址；监听与防火墙须允许相应私网访问。远端浏览器麦克风需要客户端可信的 HTTPS 和录音授权。

IP 变化后的处理必须覆盖控制面和数据面：

- 保持内部组件间 loopback 地址，避免把它们改成 DHCP 地址。
- 同机布局通常保持 `moonlight_web.public_url` 为空，CORS 用匹配实际 scheme/port 的 `{host}` 模板。
- 把新 IP 加入原 CA 下 `server.lan_tls.hosts`，核对显式 bind、公开 URL、来源及 ICE/NAT 映射。
- 原生预检后重启 Stream Kit，核对管理及网关 HTTPS，再检查真实媒体。
- 保留原 CA、服务私钥、应用数据库、配对身份和观看密钥。客户端只修改地址部分，不需要重新编译或重装原 CA。

当前版本不会自动追踪任意 DHCP 地址并更新证书；旧数字 IP 书签不会自动改写。稳定主机名依赖 LAN 解析和证书身份，不是仅改显示文字。完整步骤见[网络与证书](../docs/lan-address-configuration.md)。

## 配置保存与应用

| 范围 | 正常操作 |
| --- | --- |
| 应用入口、参数、采集模式 | 后台停止应用并等会话/原生实例终止，保存后下次启动 |
| 会话控制权与音频策略 | 保存当前会话修改，等待版本确认和新鲜观测 |
| 网关 / 编码器配置 | 保存期望值，再用管理页应用对应组件，核对新运行实例 |
| 控制端监听、账号、LAN TLS 等 | 保存后维护重启控制服务，必要时重新登录 |

配置版本冲突先重新读取，不覆盖其他有效修改。管理员不应直接编辑正在变化的配置而忽略管理页 revision。脱敏导出不能直接当作完整回退文件。

## 备份与恢复

维护前停止活动应用，停止服务或使用经过验证的 SQLite 一致性备份方法，再备份以下数据：

| 数据 | 必须保留的原因 |
| --- | --- |
| 控制、网关和 Sunshine 外部配置 | 端口、账号、目标、原生参数和运行路径 |
| SQLite 及一致状态的 WAL/相关文件 | 应用元数据、永久密钥、会话及操作记录 |
| 上传应用与平台所属文件 | 程序及入口资源 |
| 网关存储、渲染端配对/凭据状态 | 已配对身份，避免错误重新登记 |
| 部署 CA、CA 私钥、服务证书与私钥 | 客户端信任及地址更新能力 |
| 原验证运行包和清单 | 完整组件回退及来源核验 |

备份目录应只允许管理员/服务身份访问，不能放进 Git、Release 或公开截图。不要复制运行中的数据库后宣称可一致恢复，也不要将备份热覆盖到活动数据库。

回退先停止归属服务，恢复已核对兼容的完整组件及对应数据，保持目录权限，再预检、启动和验收。数据库迁移可能不支持降级；无自动通用降级承诺。不要混拷 DLL、静态资源和新旧接口造成不可追溯部署。

## 更新与卸载

Windows 当前安装器用于首次部署，拒绝覆盖现有程序/数据/服务，不提供通用原位升级。组件维护需明确匹配来源、文件清单及前后端契约，不能宣传为已重装同源整包。Linux 安装器校验既有配置并保留账号，更新前仍需停止服务、备份并核对版本兼容。

已安装 Windows 部署的人工维护入口为 `scripts/maintain-windows-runtime.cjs`，使用开发机 Node 在管理员终端运行；客户安装及运行不依赖系统 Node。先下载受信候选任务的完整 `platform` 载荷并核对发布摘要，停止活动应用，再执行只读预检：

```powershell
node scripts/maintain-windows-runtime.cjs --platform D:\Release\platform --program-dir 'C:\Program Files\StreamKit' --data-dir C:\ProgramData\StreamKit --origin https://127.0.0.1:9000 --expected-commit <完整源码SHA> --result D:\Release\preflight.json
```

以上路径、端口和 SHA 须替换为实际部署值。预检通过后，在相同命令追加 `--apply`，并换一个不存在的结果文件路径。工具检查 SCM 归属、自启动策略、受信 HTTPS、应用和媒体空闲、配置及三个组件的完整原生清单；拒绝链接目录、交叉目录、混合来源和外置组件路径。结果必须放在候选及安装/数据目录之外。预检仅写结果文件，不改服务和运行配置。

实际维护先暂存并检查文件可移动，再由 SCM 停止服务，等待归属进程退出，冷备份数据库、配对状态、配置、证书和目录权限，然后整体替换控制端、网关与 Sunshine。保留原安装器、卸载器和已安装驱动。启动后核对三个组件、来源、应用身份及配置/信任未变；失败则恢复本次冷备份及原组件。备份在安装目录的 `.maintenance-previous-*` 和受限数据目录的 `runtime-maintenance-*`，不自动删除。不支持活动业务下更新，也不承诺任意历史数据库降级；这是人工维护工具，不能替代新安装器、自启动或整机重启验收。

卸载只处理本平台匹配的服务和程序，保留运行数据；外部本机程序也不应删除。Windows 如报告需重启，按维护窗口人工重启，不强制结束其他项目。Linux 用 `sudo apt-get remove stream-kit`，保留记录的渲染用户数据。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 127.0.0.1 无法打开 | 实际 HTTP/HTTPS、端口、服务、浏览器完整错误；LAN 证书缺地址不能自动解释 loopback 失败 |
| 新 IP TLS 报错 | 证书 SAN 是否含新 IP、原 CA 是否可信、服务是否重启加载 |
| 控制端运行但组件未启动 | 配置 SID 的桌面是否登录、组件预检、路径及权限、重试/恢复记录 |
| 管理端正常但无画面 | 当前应用/原生占用、采集/编码能力、ICE UDP、防火墙、客户端解码 |
| 参数无法修改 | 是否只断开了客户端；应用、会话及原生实例是否都已停止 |
| 反复要求登录 | 管理入口与内部网关入口是否混用，是否使用有效固定链接 |
| 程序录音静音 | 目标设备、实际路由、控制权、Windows 录音隐私或用户音频服务 |
| 有几十条历史会话 | 活跃与历史是否混看；停止历史按 100 条/7 天策略保留，只读且不等于在线人数 |

先保存精确错误和组件版本再处理，避免反复重装、忽略证书、修改 ToDesk 或强制结束无关 UE。运维操作不能把测试包或测试证书引入生产。
