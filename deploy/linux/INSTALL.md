# Stream Kit：Ubuntu 24.04 安装与运行

本安装包包含管理服务、管理页面、Sunshine 和 Web/PWA 网关，适用于 Ubuntu 24.04 amd64。先核对下载文件 SHA-256，版本限制以对应发布说明为准。运行不需要 Node.js/npm、Go、Rust 或 CMake。

## 安装与自动启动

明确选择拥有实际图形及音频会话的非 root 用户：

```sh
sudo bash INSTALLER.run --user RENDER_USER
```

安装器通过 apt 补齐系统运行库，需能访问所用 Ubuntu 软件源。程序在 `/opt/stream-kit`；受保护数据在该用户 `$HOME/.local/share/stream-kit/runtime`。安装器只报告凭据文件位置，不输出密码。

没有活动桌面时添加 `--no-start`。它仍启用该用户 `stream-kit.service` 的自动启动关系，只延后本次启动；后续渲染用户桌面登录时启动，无需手工再 enable。未登录/没有 DISPLAY、WAYLAND 或音频服务时，不能宣称已具备图形串流能力。

## 访问与程序

新安装默认管理 `http://127.0.0.1:9000`，只供服务器本机。LAN 使用前配置控制/网关监听、防火墙及可信 HTTPS；已启用 TLS 后使用 HTTPS。其他设备使用服务器可达 IP/主机名，不能使用服务器 loopback。

统一管理页支持上传归档或登记已有可执行程序，设置参数及采集模式。Linux 本机文件必须已有执行权限。单渲染主机同时一个应用串流，多观看端共享，由管理员分配唯一控制权。

应用详情在启动前可复制永久观看链接，打开时按保存参数启动或加入。首次需要配对时平台按真实客户端证书指纹自动配对，之后复用身份；主机离线、身份不符或重复端点明确失败。不需要单独打开 Sunshine PIN 页面。

## 麦克风与音频

用户会话需要 PulseAudio 或 PipeWire-Pulse。平台服务准备专用虚拟录音路由，不修改默认音频设备：

- 管理端输出：`pulseaudio:stream_kit_microphone`。
- 管理端输入：`pulseaudio:stream_kit_microphone_capture`。
- 目标录音程序：`StreamKit-Microphone`。

当前控制者需主动开麦并允许系统/浏览器授权。远端 Web 采集需要可信 HTTPS；程序收到声音还须选中目标录音端点，不能只看网页图标。

音频服务重启后，在该渲染用户环境执行 `/opt/stream-kit/orchestrator/orchestrator prepare-audio`，或重启平台服务。停止时释放平台拥有的虚拟端点，不移除其他应用模块。

## 地址变化

没有域名也可使用 LAN IP。新地址须加入原部署 CA 下的 `server.lan_tls.hosts`，核对显式公开 URL/来源/ICE 配置后预检并重启服务。保留原 CA、服务私钥和应用观看密钥，不需重新编译或重装客户端信任。

固定数字 IP 书签需修改地址部分，key 保持不变。可使用证书覆盖的稳定主机名；Sunshine 复用 Avahi 发布 `主机名.local`，依赖组播/网络和客户端解析支持，不能保证跨 VLAN 或访客 Wi-Fi 可达。名称解析不替代 HTTPS 信任。

## 服务、备份与卸载

以指定渲染用户执行：

```sh
systemctl --user status stream-kit.service
systemctl --user restart stream-kit.service
systemctl --user stop stream-kit.service
journalctl --user -u stream-kit.service -n 100 --no-pager
```

维护前从后台停止应用并等终态，再停用户服务。备份私有配置、数据库、上传应用、配对状态及 CA/密钥，保留旧包。升级校验既有配置并保留账号；不要热覆盖数据库，降级兼容按版本判断。

```sh
sudo apt-get remove stream-kit
```

卸载处理记录用户的服务并保留运行数据，不选择其他用户代替清理。无桌面初始化成功、组件重启和系统整机重启是不同验证，不能从安装命令成功推断全部媒体正常。
