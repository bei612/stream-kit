# Windows 统一安装与维护

Windows x64 使用一个 EXE 安装 Orchestrator、Sunshine 和媒体网关。安装器源码为 [stream-kit.iss](stream-kit.iss)；构建及发布见[开发指南](../../docs/development.md)。当前安装包和本机维护版本见[基线](../../docs/release-status.md)。

## 安装前提与默认值

需要管理员权限，以及实际运行图形/音频程序的 Windows 用户会话。程序默认 `C:\Program Files\StreamKit`，数据默认 `C:\ProgramData\StreamKit`；程序和数据分开。首次安装拒绝覆盖已有程序目录、数据目录或服务注册，目前没有通用原位升级模式。

新安装默认监听本机 HTTP：管理 9000、网关 8080，Sunshine 基础端口 47989、内部管理 47990。LAN 和 HTTPS 需按部署环境配置，不能把本机初始地址发给其他设备。

普通运行不安装 Node.js/npm、SDK 或编译器。必要 MSVC release CRT 以应用本地文件分发，摘要与 `WINDOWS-RUNTIME.json` 纳入组件清单；不会每次启动安装系统级运行库。

## 静默与向导

向导和静默走同一组原生初始化、驱动及服务命令。静默优先，在管理员终端执行实际下载文件：

```powershell
.\INSTALLER.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

Windows UAC 仍适用；静默模式不会绕过系统提权，也不会自动重启电脑或修改 PowerShell 执行策略。

| 参数 | 用途 |
| --- | --- |
| `/DIR="C:\Program Files\StreamKit"` | 不可变运行文件位置 |
| `/DATADIR="C:\ProgramData\StreamKit"` | 外部运行数据；父目录需存在 |
| `/ADMINFILE="C:\protected\administrator.json"` | 可选私有管理员凭据 JSON |
| `/CONTROLPORT=19000` | 自定义管理端口 |
| `/GATEWAYPORT=18080` | 自定义网关端口 |
| `/RENDERERPORT=48989` | Sunshine 原生基础端口，相关偏移一并派生 |
| `/SESSIONID=… /USERSID="…"` | 非交互 Session 0 部署需明确提供目标桌面会话及 SID |

正常交互安装从当前桌面确定真实渲染用户，即使用另一管理员身份提权也不应绑定错误用户。会话 ID 只用于初始化识别，后续开机按用户 SID 查找活动会话，不沿用旧会话号。

`ADMINFILE` 包含 `name` 和 `password`；密码要求 12–1024 UTF-8 字节。文件权限仅授予安装管理员，凭据不放进命令行。未提供时静默生成独立密码并保存在管理员/System 可读的 `orchestrator.json`。安装器只报告位置，不打印内容；外部提供文件由部署方保管和清理。

## 自动启动关系

安装器本身完成：

1. 校验整包及原生配置，准备数据和必要音频设备。
2. 注册唯一 SCM 服务 `StreamKitOrchestrator`，配置 Automatic、LocalSystem 及故障恢复。
3. 启用 Sunshine、媒体网关的组件自动启动与恢复策略。
4. 正常启动时检查控制端构建身份、自动组件 running 和实际 PID；不能只凭 SCM Running 报就绪。

控制服务可在登录前启动，Sunshine 和网关通过已认证的用户会话工作进程启动，等待配置用户的活动桌面。系统自动登录不会被开启。不要额外注册 Sunshine 服务、任务计划或启动文件夹项。

| 结果 | 含义 |
| --- | --- |
| `0` | 本次初始化及配置的服务就绪检查完成 |
| `3010` | 驱动/端点准备要求人工重启；自动服务关系仍已建立，不代表当前可串流 |
| 其他非零 | 失败，核对安装日志及保留的数据；静默不能把失败吞成成功 |

服务重启检查与整机重启验收不同；自动配置也不保证未登录桌面时有图像采集。

## 开源虚拟音频

产品不下载、不分发、不安装 VB-CABLE，也不要求其商业授权。已有兼容端点仍可通过统一路由选择。

正式 Windows 包使用开源软件虚拟音频和固定的 usbip-win2 控制器/过滤驱动运行文件。驱动源码归档位于 `third_party/usbip-win2`，允许分发的 INF/SYS/CAT/许可证库存见 `orchestrator/internal/audiodevice/usbip-driver.json`。这是已签名的上游驱动，不声称本项目重新编译并取得内核签名。

打包使用官方 Windows SDK `signtool verify /kp` 检查目录签名，安装时核对嵌入清单；不启用 testsigning、不安装开发测试证书。使用公开允许共享的 Audio 类 `16c0:27e0` 与产品身份前缀，每次部署生成独立持久序列号；无需外部申请独占 USB 编号，不是 USB-IF 认证声明。

驱动安装在同一次已提权流程中进行，重用健康兼容控制器；冲突/半安装状态明确拒绝，失败只清理本次节点，保留可能共享的 DriverStore。专用音频设备在网关启动前准备默认输出策略，后续启动复用完成状态，不反复装驱动。首次未准备的枚举仍可能短暂影响系统默认设备，不能据空设备测试承诺所有客户已有默认设置绝无变化。

录音应用须选择专用 capture 端点。Windows 录音隐私仍由指定用户的系统设置管理；安装驱动不会自动授予桌面应用录音权限，客户安装器不会修改用户隐私策略。虚拟显示驱动不提供这个音频能力。

## 维护命令与检查

在管理员 PowerShell 维护服务：

```powershell
Get-Service StreamKitOrchestrator
Restart-Service StreamKitOrchestrator
```

先在管理端停止应用，等待终态再重启。原生预检：

```powershell
& 'C:\Program Files\StreamKit\orchestrator\orchestrator.exe' check-config --config 'C:\ProgramData\StreamKit\orchestrator.json'
```

`check-config` 不签发证书、不打开监听、不启动应用；通过不代替服务身份、桌面和媒体检查。LAN IP/TLS 变更按[地址手册](../../docs/lan-address-configuration.md)执行，既有 CA、应用和固定观看密钥保留。

## 卸载与更新

卸载停止并移除匹配的服务和程序，保留配置、数据库和应用数据。卸载不等于删除用户数据，也不应移除外部本机应用。

当前安装器不提供通用原位升级或数据库自动降级。维护前停止串流，备份受保护数据及旧完整组件，核对前后端/协议兼容后整体替换对应组件。不要把新文件覆盖到运行中的目录，也不要只换一个 EXE 而遗漏同源静态资源或依赖。

## 构建与精确发布

构建使用干净来源、组件清单和统一包验证；必须排除 Example、音源、probe、Playwright、签名私钥和开发 CA。官方 CMake、Inno Setup 与签名工具由构建环境提供，不装进客户机。

```text
node scripts/build-windows-installer.mjs PLATFORM_BUNDLE NEW_OUTPUT OFFICIAL_ISCC_EXE --usb-audio-driver deploy/windows/usb-audio-driver --signtool OFFICIAL_SIGNTOOL_EXE --usb-audio-identity deploy/windows/usb-audio-identity.json
```

安装器专属修正可在明确审查下用 `--reuse-payload` 复用不可变原始载荷，清单区分 payload 与 installer_source_commit，不表示旧二进制包含新运行代码。CI 发布复用原始安装器并核对其安装验收 SHA，不为写发布说明重复编译。

安装器本身暂不使用商业发行者证书，本次不要求购买；这不取消附带内核驱动签名及依赖许可要求。
