# Stream-Kit：Ubuntu 24.04 安装与运行

本安装包适用于 Ubuntu 24.04 amd64，包含统一管理服务、管理页面、Sunshine 渲染端和 Web/PWA 媒体网关。安装前核对随下载提供的 SHA-256 校验文件。版本状态及已知问题以对应版本的发布说明为准。

## 安装

选择实际运行渲染程序的非 root 桌面用户，将下列 `INSTALLER.run` 和 `RENDER_USER` 替换为下载文件名和用户名：

```sh
sudo bash INSTALLER.run --user RENDER_USER
```

安装器使用包管理器补齐系统运行库，初始化私有数据，并启用该用户的 `stream-kit.service`。缺少运行库时，需要能访问 Ubuntu 软件源。运行不需要 Node.js、npm 或编译工具。

安装依赖包含 Sunshine 原有局域网发布功能所需的 Avahi 客户端库、Avahi 服务及 `.local` 名称解析模块。可在允许组播的同一局域网使用 `主机名.local` 作为稳定入口；主机名保持不变时无需把固定链接绑定到某个 DHCP 地址。此方式依赖服务正常运行、客户端支持 mDNS 和网络允许 UDP 5353，不保证跨 VLAN、访客 Wi-Fi 或禁用组播的网络可用。HTTPS 证书必须覆盖该主机名并被客户端信任；名称解析不代替证书验证。数字 IP 书签不会自动改写。

尚未登录图形桌面时，可附加 `--no-start` 安装并初始化，暂不立即启动。安装器仍会启用该用户的服务自启动；随后以指定用户登录，用户服务管理器将自动启动平台，无需另行执行启用命令。

渲染与音频运行需要该用户的图形会话，以及可用的 PulseAudio 或 PipeWire-Pulse 音频服务。无桌面安装成功不代表采集已经可用。

## 管理与音频

默认管理入口为 `http://127.0.0.1:9000`。安装器只显示受保护的凭据文件位置，不输出密码。程序文件位于 `/opt/stream-kit`，配置、数据库与上传应用位于渲染用户的 `$HOME/.local/share/stream-kit/runtime`。不要公开配置文件。

通过统一管理页面配置渲染主机，上传应用压缩包或选择已有可执行程序，设置程序窗口或桌面采集，并管理观看会话和控制权。远程浏览器麦克风需要可信 HTTPS 和浏览器录音授权；默认监听地址仅供本机访问，远程接入前需配置相应监听地址、公开媒体地址和 TLS。

服务启动时在该用户的音频服务中准备专用虚拟麦克风。管理页选择输出 `pulseaudio:stream_kit_microphone` 和输入 `pulseaudio:stream_kit_microphone_capture`；目标录音程序选择 **StreamKit-Microphone**。平台不将其设为系统默认设备。

音频服务重启后可执行 `/opt/stream-kit/orchestrator/orchestrator prepare-audio` 重新准备端点，或重启平台服务。服务停止时释放本平台创建的虚拟端点。

## 停止、更新与卸载

```sh
systemctl --user status stream-kit.service
systemctl --user stop stream-kit.service
```

更新前停止活动会话、备份私有数据并保留旧安装包。更新会校验并保留现有配置，不重新生成管理员凭据。不要把备份数据库覆盖到仍在运行的服务上。数据库降级兼容性以对应版本说明为准。

```sh
sudo apt-get remove stream-kit
```

卸载停止并禁用所记录用户的服务，保留配置与应用数据。其他用户的服务和无关音频模块不由本平台清理。
