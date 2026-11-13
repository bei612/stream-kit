# Stream Kit

Stream Kit 是一体化云端应用串流平台。管理员在浏览器中发布和启动服务器上的程序，客户端通过固定观看链接接收画面、程序声音，并在取得唯一控制权后发送键鼠、触摸和麦克风。

服务端支持原生 Windows 与 Linux；客户端提供 Web/PWA 和原生 Android。管理端只有一个管理员。一个渲染主机当前同时运行一个应用串流，多个客户端共享该应用；登记多个应用不代表可同时独立串流多个应用。

## 文档入口

| 内容 | 长期文档 |
| --- | --- |
| 完整文档导航与维护规则 | [文档索引](docs/README.md) |
| 产品范围、核心行为与限制 | [项目需求](docs/项目需求.md) |
| 模块、数据所有权、协议及生命周期 | [技术架构](docs/技术架构细节.md) |
| 添加应用、固定链接、观看及权限交接 | [使用手册](docs/user-guide.md) |
| 安装、自启动、备份和故障排查 | [部署运维](deploy/README.md) |
| Windows 单 EXE 安装 | [Windows 安装说明](deploy/windows/README.md) |
| Ubuntu 24.04 单文件安装 | [Linux 安装说明](deploy/linux/INSTALL.md) |
| 只有 IP 的部署、HTTPS 及换 IP | [局域网地址与证书](docs/lan-address-configuration.md) |
| Android 操作与 Web 的差异 | [Android 客户端](docs/android-viewer-controls.md) |
| 当前发布、本机部署和未验证边界 | [发布与部署基线](docs/release-status.md) |
| 源码构建、检查及发布 | [开发指南](docs/development.md) |

## 安装与首次访问

从 [GitHub Releases](https://github.com/bei612/stream-kit/releases) 下载对应平台的安装器并核对 SHA-256。每个平台一个服务端安装包，包含管理服务、Sunshine 和媒体网关。运行不要求宿主机安装 Node.js/npm、Go、Rust 或 CMake，也不依赖 VB-CABLE。

Windows 在管理员终端执行实际下载的安装文件：

```powershell
.\INSTALLER.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART
```

安装器建立一个自动启动的 Windows 服务 `StreamKitOrchestrator`，由它管理两个媒体组件；无需安装后手工添加启动项。控制服务可在登录前启动，画面和音频采集仍需要配置用户的交互桌面。驱动要求重启时安装器返回 `3010`，不会自动重启。

Ubuntu 24.04 amd64 选择实际拥有图形和音频会话的非 root 用户：

```sh
sudo bash INSTALLER.run --user RENDER_USER
```

安装器启用该用户的 `stream-kit.service`。无桌面会话时添加 `--no-start` 延后本次启动；后续桌面登录的自动启动关系仍由安装器建立。

新安装默认使用本机 HTTP：管理端 `http://127.0.0.1:9000`、网关 `http://127.0.0.1:8080`。已配置 HTTPS 的部署必须使用 HTTPS，不能套用初始 HTTP 地址。管理员凭据保存在受保护的 `orchestrator.json`，不存在公开通用密码。其他设备访问时使用可达 LAN 地址或可解析主机名，不能使用服务器的 `127.0.0.1`。

## 核心使用

1. 登录管理端，检查渲染端和媒体网关就绪。
2. 上传 ZIP、7z、RAR、TAR 或受支持的压缩 TAR，或直接登记服务器已有程序的绝对路径。
3. 设置启动参数和桌面/指定程序采集模式。修改启动参数前通过后台停止应用并等候串流终止。
4. 在应用详情启用、复制固定观看链接，无需先启动串流。客户端打开链接后按后台保存参数唤起程序或加入现有串流。
5. 管理端查看当前连接并授予、转移或撤销唯一控制权。旁观者不能控制或发麦克风。
6. 配置目标录音端点；控制者主动开启麦克风后，声音送达目标程序，并与程序音混合广播给观看端。

固定链接长期有效，管理员可轮换或禁用。永久观看密钥、短时入场邀请、连接凭据和媒体票据是不同权限层；不需要把管理员账号交给观看者。服务器换 IP 不会改写已有数字 IP 书签，当前版本须更新地址配置并重启服务，保留原 CA 后无需重新安装客户端信任或编译客户端。

## 源码与边界

`third_party/` 直接纳管二开源码及必要依赖，不使用 submodule；来源见 [上游清单](third_party-manifests/README.md)。`docs/src/` 仅是历史参考，不是生产构建入口。Example 与验收工具独立于生产包。

当前发布渠道仍为预发布。发布版本、本机混合组件版本、实际验收范围和未完成项统一见[发布与部署基线](docs/release-status.md)，不要从旧发布记录或某个组件状态推断全部生产验收已完成。
