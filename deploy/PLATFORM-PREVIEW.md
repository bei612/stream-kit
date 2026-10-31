# Stream-Kit Windows 平台运行文件

本包包含同一源码提交构建的管理服务及管理页面（orchestrator）、媒体网关及 Web/PWA（media-gateway）、Sunshine 渲染端（sunshine）。各组件保留独立文件清单，整包版本和 SHA-256 清单见 platform-manifest.json。

此目录既可由统一 EXE 安装器安装，也可作为便携预发布包部署。安装和运行均不需要宿主机安装 Node.js/npm、Go、Rust 或 CMake。源码构建工具不属于产品运行依赖。

使用统一安装器时，组件路径、外部数据目录、唯一管理员凭据和 Windows 控制服务已经初始化。直接访问管理页面，不要再执行下面的便携初始化步骤或重复注册服务。默认入口为 `http://127.0.0.1:9000`；指定安装端口时使用对应端口。静默安装生成的管理员凭据位于所选数据目录受保护的 `orchestrator.json` 中，字段为 `server.username` 和 `server.password`。

当前仍为预发布。程序未做发行者代码签名；商业签名证书不作为本次交付要求。物理麦克风完整回传/广播及 UE5 接收、第三方驱动分发授权和鲜装/重启验收尚未闭合；当前公开包不附带虚拟音频驱动。已有生成信号的录音端点和 SCM 媒体补充证据不能替代物理语音验收。

## 便携目录手工部署

1. 将本目录解压至固定位置，例如 `D:\StreamKit\releases\preview`。将配置、数据库、日志和上传程序放在独立数据目录，升级时保留该目录。
2. 在 PowerShell 中执行 `orchestrator\orchestrator.exe init-config --config D:\StreamKit\data\orchestrator.json`。从新生成的受保护配置文件读取唯一管理员的用户名和随机密码；不要公开该文件。初始管理入口仅监听 `http://127.0.0.1:9000`。
3. 启动 `orchestrator\orchestrator.exe --config D:\StreamKit\data\orchestrator.json`，登录管理页，在组件配置中设置本包内 Sunshine 和网关的绝对程序路径、各自工作目录及外部配置参数。媒体组件默认不自动启动。
4. 按 `media-gateway/GATEWAY-BUNDLE.md`、`sunshine/RENDERER-BUNDLE.md` 完成媒体配置。网关可用 `web-server.exe --config-path 外部配置路径 config generate` 生成其原生配置。管理服务和网关必须使用一致的媒体票据密钥；将网关存储路径及 Sunshine 的状态、凭据、证书和日志路径配置在外部数据目录。
5. 配置 Sunshine 管理连接及网关地址、完成主机配对，再添加本机已有程序或上传程序包。按应用选择程序窗口／桌面捕获及相应音频模式，通过管理页创建会话和发放观看链接。需要麦克风回传时，必须先准备实际可用的虚拟音频端点对，并由管理页明确选择目标设备。

公网使用须配置 HTTPS 和可达的媒体网络地址；浏览器麦克风权限不能由服务端绕过。Windows 服务化部署入口在 `orchestrator/install-windows-service.ps1`，需先配置交互用户的 Windows 会话和 SID；先完成交互方式运行再安装服务。不要同时安装独立 Sunshine 服务。

## 升级及回退

将新版本解压至新目录，停止接入和活动会话，停止受管组件后同步更新程序路径与工作目录。配置和数据目录保持独立，保留旧版本与升级前数据备份。当前包不执行数据库降级或自动覆盖现有服务。四小时长稳的历史验收不代表本包已完成所有端到端验收。
