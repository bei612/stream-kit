# Linux 部署实现与维护

客户操作以 [INSTALL.md](INSTALL.md) 为准，该说明随产品分发。本文面向维护开发者；Windows 与 Linux 的服务身份不同，不能套用 SCM、Session ID 或 Windows 虚拟音频驱动。

## 安装器与会话

Ubuntu 24.04 amd64 使用一个含 SHA-256 校验 Debian 载荷的 `.run` 文件。以 root 安装不可变程序及系统运行库，明确选择实际拥有桌面和音频的非 root 渲染用户；控制服务和媒体不以 root 运行。

```sh
sudo bash INSTALLER.run --user RENDER_USER
```

原生 `init-platform` 与 Windows 共用清单验证、独立凭据生成、端口检查和配置准备。安装器启用 `stream-kit.service` 用户服务，服务管理 Sunshine 与网关。没有桌面时用 `--no-start` 延后立即启动，安装器仍离线 enable，后续渲染用户登录时自动运行；不要求安装后再手工补 enable。

图形会话、用户服务管理器、DISPLAY/WAYLAND 和 PulseAudio/PipeWire-Pulse 必须可用。初始化可在无 GPU/音频流时完成，但初始化成功不是媒体就绪。未自动授予 KMS CAP_SYS_ADMIN，也不新增 root 图形守护进程。

## 目录与来源

| 内容 | 路径 |
| --- | --- |
| 程序根 | `/opt/stream-kit` |
| 控制端与管理资源 | `orchestrator/` |
| 网关与观看资源 | `media-gateway/` |
| Sunshine | `sunshine/bin/sunshine`、`sunshine/share/sunshine` |
| 运行数据 | 渲染用户 `$HOME/.local/share/stream-kit/runtime` |
| 安装记录的渲染用户 | `/var/lib/stream-kit/render-user` |

原生布局唯一目录定义是 `orchestrator/internal/bundle/layouts.json`。Sunshine 使用 platform CMake/DESTDIR 布局，保留 bin/lib/share、ELF RPATH 及私有 Vulkan loader；不是把 Windows 文件平铺到 Linux。媒体资源从当前可执行位置解析。

初始化要求可信归属的私有父目录，拒绝共享可写父目录及覆盖既有目标，发布使用 `RENAME_NOREPLACE` 并同步父目录；不支持时失败，不退回覆盖。失败 staging 保持私有用于诊断。

## 图形、输入与音频

包提供 Sunshine 输入设备规则、uinput/uhid 模块配置，安装后加载及触发相应设备；不扩大所有设备权限。实际窗口/桌面采集及编码能力受图形后端、GPU 驱动和会话影响。

服务在渲染用户已认证的 PulseAudio/PipeWire-Pulse 中准备专用 48 kHz 虚拟 sink/source：

- 输出 ID：`pulseaudio:stream_kit_microphone`。
- 输入 ID：`pulseaudio:stream_kit_microphone_capture`。
- 目标录音程序选择 `StreamKit-Microphone`。

复用匹配模块，拒绝他人占用的同名设备，失败只回滚本次模块；停止时按依赖顺序释放本平台设备，不切换系统默认设备或创建另一套音频服务。

音频服务重启后，可在该用户环境运行 `/opt/stream-kit/orchestrator/orchestrator prepare-audio`，或重启平台服务；`release-audio` 使用同一归属检查释放。生产包不包含原生录音 probe。

## 网络与更新

默认 loopback HTTP 管理 9000、网关 8080、Sunshine 原生 47989。LAN 需开放对应监听、可信 HTTPS 和实际媒体 UDP。依赖包括 Avahi client、daemon 和名称解析模块，复用 Sunshine 发布，不另加发现服务；是否在客户网络可解析仍须实查。

包管理升级校验并保留既有配置，不重新生成管理员身份。更新前先停活动串流及用户服务，备份运行数据和旧包；数据库降级需按版本确认。卸载在用户管理器可用时停止并禁用记录用户的服务，保留数据，不选择其他用户代替操作。

## 构建与验证边界

```sh
SUNSHINE_PACKAGE_LAYOUT=platform SUNSHINE_REQUIRE_CLEAN=1 bash scripts/build-sunshine.sh
```

控制/网关/渲染组件同源验证后组装安装器。依赖锁、SBOM、来源、文件摘要、初始化和真实页面检查分别保留；精确版本状态见[发布基线](../../docs/release-status.md)。

Windows 上 Linux 交叉编译不等于原生 Linux 运行。CI 的原生文件权限、音频服务、安装包及实际页面证据也不等于客户 GPU、物理设备或共享 Windows 主机的重启/网络迁移。本轮不要求 Linux 真机验收，不能因此宣称所有 Linux 硬件已通过。
