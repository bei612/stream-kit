# Stream-Kit 使用手册

> 本手册面向在 Windows 环境下部署和使用 Stream-Kit 的用户。
> Stream-Kit 通过 ⓪ Orchestrator 统一管理串流服务，实现应用的上传、部署和浏览器远程串流。

---

## 目录

- [1. 系统概述](#1-系统概述)
- [2. 程序角色总览](#2-程序角色总览)
- [3. 安装部署](#3-安装部署)
- [4. 目录结构](#4-目录结构)
- [5. 首次配置](#5-首次配置)
- [6. 启动与运行](#6-启动与运行)
- [7. 日常使用流程](#7-日常使用流程)
  - [7.1 上传应用](#71-上传-ue5-应用)
  - [7.2 开始串流](#72-开始串流)
  - [7.3 管理组件](#73-管理组件)
  - [7.4 查看日志](#74-查看日志)
- [8. 配置详解](#8-配置详解)
- [9. 网络与防火墙](#9-网络与防火墙)
- [10. 浏览器兼容性](#10-浏览器兼容性)
- [11. 常见问题与排查](#11-常见问题与排查)
- [12. 端口速查表](#12-端口速查表)

---

## 1. 系统概述

Stream-Kit 由以下组件组成：

| 组件 | 作用 | 你需要操作吗？ |
|------|------|:-------------:|
| **⓪ Orchestrator** | 统一管理中心，Web 界面 | **启动它即可** |
| ① Sunshine | 屏幕捕获 + 编码推流 | 提前安装好 |
| ② web-server | 浏览器串流中转 | ⓪ 自动管理 |
| ③ streamer | 串流子进程 | ② 自动管理 |

**核心理念**：你只需要启动 ⓪ Orchestrator，它会自动拉起并管理 ① 和 ②。通过 ⓪ 的 Web 界面即可完成所有操作。

---

## 2. 程序角色总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  Windows 工作站                                                      │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │  ⓪ Orchestrator（你启动这一个）                          │         │
│  │     管理界面：http://localhost:9000                       │         │
│  │                                                           │         │
│  │  功能：                                                    │         │
│  │  · 自动启停 ① ②                                          │         │
│  │  · 上传/管理应用包                                   │         │
│  │  · 注册应用到 Sunshine                                    │         │
│  │  · 一键跳转串流                                           │         │
│  │  · 实时状态监控                                           │         │
│  └──────────┬──────────────────────────────────┘             │         │
│             │ 自动管理                                        │         │
│             ▼                                                 │         │
│  ┌──────────────────┐                                        │         │
│  │ ① Sunshine        │◄── 捕获应用画面                     │         │
│  │   :47989/47990    │                                        │         │
│  └───────┬──────────┘                                        │         │
│          │                                                    │         │
│  ┌──────────────────────┐     WebRTC      ┌──────────┐      │         │
│  │ ② web-server.exe     │◄══════════════►│ 浏览器    │      │         │
│  │   :8080               │                 │ (观看端)  │      │         │
│  │   └─ ③ streamer.exe  │                 └──────────┘      │         │
│  └──────────────────────┘                                    │         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 安装部署

### 3.1 前置条件

1. **安装 Sunshine**：从 [GitHub](https://github.com/LizardByte/Sunshine) 下载安装，完成首次设置（创建用户名密码）
2. **安装 Moonlight-Web-Stream**：从 [GitHub](https://github.com/MrCreativ3001/moonlight-web-stream) 下载 Windows 版本，解压到任意目录
3. **操作系统**：Windows 10 / 11（x86_64）

### 3.2 部署 Stream-Kit

1. 下载 Stream-Kit Orchestrator 发布包，解压到目标目录（如 `D:\stream-kit\`）

2. 确认最终目录结构：

```
D:\stream-kit\
├── orchestrator.exe          # ⓪ 主程序
├── dist\                     # ⓪ Web 界面文件
│   ├── index.html
│   └── assets\
├── config.json               # ⓪ 配置文件（首次运行自动生成）
├── moonlight-web\            # ② Moonlight-Web-Stream
│   ├── web-server.exe
│   ├── streamer.exe
│   └── static\
└── data\                     # 运行时数据（自动创建）
```

> ① Sunshine 通常安装在 `C:\Program Files\Sunshine\`，无需移动。

---

## 4. 目录结构

首次运行后，⓪ 会自动创建以下目录：

```
D:\stream-kit\
├── orchestrator.exe
├── dist\                     # Web 界面
├── config.json               # 配置文件
├── data\
│   ├── orchestrator.db       # 数据库
│   └── pids.json             # 子进程 PID 记录（异常退出检测用）
├── apps\                     # 应用存放目录
│   └── {应用ID}\             # 每个应用一个独立目录
├── temp\                     # 上传临时目录
├── logs\                     # 日志目录
└── moonlight-web\            # ② ③ 程序
```

---

## 5. 首次配置

### 5.1 生成配置文件

首次运行 `orchestrator.exe`，程序会自动生成 `config.json` 并退出：

```powershell
.\orchestrator.exe
# 输出：首次运行，已生成默认配置：D:\stream-kit\config.json
#       请检查配置后重新启动。
```

### 5.2 编辑配置文件

用文本编辑器打开 `config.json`，修改以下关键字段：

```jsonc
{
  "server": {
    "bind_address": "0.0.0.0:9000",    // ⓪ 监听地址（0.0.0.0 允许远端访问）
    "username": "admin",                // ⓪ 登录用户名
    "password": "admin"                 // ⓪ 登录密码（请修改）
  },

  "components": {
    "sunshine": {
      "exe_path": "",                   // 留空 = Sunshine 由 Windows 服务管理，⓪ 仅监控
      "auto_start": true                // 启动时自动检测 Sunshine 健康状态
    },
    "web_server": {
      "exe_path": "C:\\Program Files\\Moonlight\\moonlight-web-x86_64-pc-windows-gnu\\web-server.exe",
      "working_dir": "C:\\Program Files\\Moonlight\\moonlight-web-x86_64-pc-windows-gnu\\",
      "auto_start": true                // ⓪ 启动时自动拉起
    }
  },

  "sunshine_api": {
    "base_url": "https://localhost:47990",
    "username": "sunshine",    // ← 改为 Sunshine 的用户名
    "password": "sunshine"     // ← 改为 Sunshine 的密码
  },

  "moonlight_web": {
    "base_url": "http://localhost:8080"
  }
}
```

> **其他字段保持默认即可。** 完整配置说明见 [第 8 节](#8-配置详解)。

### 5.3 预配置 Moonlight-Web-Stream

在启动 ⓪ 之前，需要先手动完成一次 Moonlight-Web 的初始配置：

1. 手动运行 `moonlight-web\web-server.exe`
2. 浏览器打开 `http://localhost:8080`
3. 创建首个管理员账户
4. 添加 Sunshine 主机（地址 `localhost`，端口留空）
5. 完成 PIN 码配对
6. 关闭 `web-server.exe`

> 配对只需做一次，之后由 ⓪ 自动管理 ②。

---

## 6. 启动与运行

### 基本启动

```powershell
cd D:\stream-kit
.\orchestrator.exe
```

⓪ 启动后自动执行：
1. 加载配置 → 初始化数据库
2. 恢复上次异常中断的应用状态
3. 监控 ① Sunshine 健康状态（Sunshine 由 Windows 服务自动运行）
4. 自动启动 ② web-server.exe（等待健康检查通过）
5. 开始监听 `http://localhost:9000`

### 访问管理界面

浏览器打开 **`http://localhost:9000`**

首次访问会跳转到登录页面，输入 `config.json` 中配置的用户名和密码（默认 `admin` / `admin`）。登录后 24 小时内无需重新登录。

### 后台运行

推荐使用 [NSSM](https://nssm.cc/) 注册为 Windows 服务：

```powershell
nssm install StreamKit "D:\stream-kit\orchestrator.exe"
nssm set StreamKit AppDirectory "D:\stream-kit"
nssm set StreamKit DisplayName "Stream-Kit Orchestrator"
nssm start StreamKit
```

**注意**：服务账户必须是登录的桌面用户（非 SYSTEM），因为 Sunshine 需要 GPU 访问权限。

或更简单：将 `orchestrator.exe` 的快捷方式放入用户启动文件夹（按 `Win+R`，输入 `shell:startup`）。

---

## 7. 日常使用流程

### 7.1 上传应用

1. 打开 ⓪ 管理界面 → 点击侧栏 **「上传应用」**
2. 拖入应用压缩包（支持 zip、tar.gz、tar.bz2）
3. 填写应用名称
4. 选择启动参数：
   - **无参数**（默认）：直接运行 exe，适合大多数程序
   - **预设模板**：全屏/窗口化等常用配置（UE5 适用）
   - **自定义参数**：多行文本框，每行一个参数
5. 点击 **「开始上传」**

上传完成后自动执行：
- 解压 → 检测入口 exe → 注册到 Sunshine

应用状态变为 **「就绪」** 即可串流。

> 支持任意 Windows 程序（含 UE5、Unity、普通桌面应用等）。
> 如果检测到多个可执行文件，系统会提示你选择正确的入口 exe。
> 含空格的路径参数请用引号包裹，如 `"-logdir C:\My Games\logs"`。

### 7.2 启动串流

1. 打开 ⓪ 管理界面 → **「应用管理」** 或 **应用详情页**
2. 点击 **「启动串流」** 按钮
3. 系统自动检查编码器状态 → 打开串流窗口 → 应用画面出现在浏览器中
4. 应用状态自动变为 **「运行中」**（由后台轮询编码器状态检测）

> 同一时间只能串流一个应用。如果已有应用在串流，需先停止后再启动新的。

### 7.3 停止串流

1. 在应用详情页或列表页点击 **「停止串流」**
2. 系统调用编码器关闭接口 → 等待确认 → 状态变为 **「已停止」**

> 删除运行中的应用时，系统会自动先停止串流再删除。

### 7.4 管理组件

在 **「组件管理」** 页面可以：

- 查看 ① Sunshine 和 ② web-server 的运行状态（绿色=运行中，红色=异常）
- 手动启动/停止/重启单个组件
- 查看组件的实时日志输出

> 如果组件崩溃，⓪ 会自动尝试重启（可在配置中关闭）。

### 7.5 查看日志

**「操作日志」** 页面记录所有操作历史：

- 组件启停事件
- 应用上传/解压/注册记录
- 错误和崩溃信息

支持按类型筛选和分页查看。

---

## 8. 配置详解

### 完整配置文件结构

```jsonc
{
  // ⓪ 服务器设置
  "server": {
    "bind_address": "0.0.0.0:9000",    // 监听地址（0.0.0.0 允许远端访问）
    "username": "admin",                // 登录用户名
    "password": "admin",                // 登录密码（请修改为强密码）
    "jwt_secret": "",                   // JWT 签名密钥（留空则从密码派生）
    "tls_cert": "",                     // HTTPS 证书路径（可选）
    "tls_key": "",                      // HTTPS 私钥路径（可选）
    "log_level": "info"                 // 日志级别：debug/info/warn/error
  },

  // 被管理的组件
  "components": {
    "sunshine": {
      "exe_path": "",                   // 留空 = 仅监控模式（Sunshine 由 Windows 服务管理）
      "args": "",
      "working_dir": "",
      "env": {},
      "auto_start": true,              // 启动时自动监控 Sunshine 健康状态
      "restart_on_crash": false,       // 仅监控模式下无需重启
      "restart_delay_seconds": 5,      // 重启等待秒数
      "max_restart_attempts": 3,       // 最大连续重启次数
      "health_check": {
        "url": "https://localhost:47990/api/configLocale",
        "interval_seconds": 10,        // 检查间隔
        "timeout_seconds": 5,          // 单次超时
        "unhealthy_threshold": 3,      // 连续失败 N 次标记不健康
        "healthy_threshold": 1,        // 连续成功 N 次恢复
        "startup_timeout_seconds": 60, // 启动后最长等待
        "verify_ssl": false
      }
    },
    "web_server": {
      "exe_path": "C:\\Program Files\\Moonlight\\moonlight-web-x86_64-pc-windows-gnu\\web-server.exe",
      "working_dir": "C:\\Program Files\\Moonlight\\moonlight-web-x86_64-pc-windows-gnu\\",
      "auto_start": true,
      "restart_on_crash": true,
      "health_check": {
        "url": "http://localhost:8080",
        "interval_seconds": 10,
        "timeout_seconds": 5,
        "startup_timeout_seconds": 60
      }
    }
  },

  // Sunshine API 连接（用于注册应用）
  "sunshine_api": {
    "base_url": "https://localhost:47990",
    "username": "admin",
    "password": "your-password",
    "verify_ssl": false
  },

  // Moonlight-Web 连接（用于构建串流链接）
  "moonlight_web": {
    "base_url": "http://localhost:8080"
  },

  // 存储设置
  "storage": {
    "apps_dir": "./apps",              // 应用解压目录（支持绝对路径如 D:\\GameApps）
    "temp_dir": "./temp",              // 上传临时目录（支持绝对路径如 D:\\Temp）
    "db_path": "./data/orchestrator.db",
    "max_upload_size_bytes": 53687091200,  // 上传限制（默认 50GB）
    "max_extract_size_bytes": 53687091200, // 解压后总大小限制
    "max_file_count": 100000               // 单压缩包最大文件数
  },

  // 进程管理
  "process": {
    "monitor_interval_seconds": 5,
    "graceful_shutdown_timeout_seconds": 5
  },

  // 事件通知（可选）
  "notifications": {
    "webhook_url": "",                     // 空则不发送
    "events": ["component_error", "component_crashed", "app_crashed", "disk_low"]
  },

  // 启动参数模板（可自定义添加）
  "templates": {
    "fullscreen_1080p": "-game -fullscreen -ResX=1920 -ResY=1080 -ForceRes",
    "fullscreen_2k": "-game -fullscreen -ResX=2560 -ResY=1440 -ForceRes",
    "fullscreen_4k": "-game -fullscreen -ResX=3840 -ResY=2160 -ForceRes",
    "windowed_1080p": "-game -windowed -ResX=1920 -ResY=1080 -ForceRes"
  },

  // 日志设置
  "log": {
    "level": "info",
    "file": {
      "enabled": true,
      "path": "./logs/orchestrator.log",
      "max_size_mb": 100,
      "max_backups": 5,
      "max_age_days": 30,
      "compress": true
    },
    "access_log": {
      "enabled": true,
      "exclude_paths": ["/api/v1/health", "/api/v1/ws"]
    },
    "operation_log": {
      "max_age_days": 30,               // 操作日志保留天数
      "max_count": 100000               // 操作日志最大条数
    }
  }
}
```

### 常用命令

```powershell
# 启动（使用默认 config.json）
.\orchestrator.exe

# 指定配置文件
.\orchestrator.exe --config D:\other\config.json

# 打印当前配置（脱敏）
.\orchestrator.exe print-config

# 查看版本
.\orchestrator.exe version
```

### 远程访问

默认绑定 `0.0.0.0:9000`（允许远端访问）。安全建议：

1. 修改默认密码（`admin/admin`）为强密码
2. 配置 TLS 证书（推荐），或使用反向代理
3. 放行防火墙端口 9000
4. 如仅需本机访问，改 `bind_address` 为 `127.0.0.1:9000`

---

## 9. 网络与防火墙

### 需要放行的端口

远端客户端需要访问以下端口才能正常管理和串流。以**管理员权限**运行 PowerShell 一次性配置：

```powershell
# ⓪ Orchestrator 管理界面
netsh advfirewall firewall add rule name="云端渲染-管理界面" dir=in action=allow protocol=tcp localport=9000

# ② 串流网关（Moonlight-Web 页面 + WebSocket 信令）
netsh advfirewall firewall add rule name="云端渲染-串流网关" dir=in action=allow protocol=tcp localport=8080

# ① 编码器 Sunshine（API + 串流协议）
netsh advfirewall firewall add rule name="云端渲染-编码器TCP" dir=in action=allow protocol=tcp localport=47984,47989,47990,48010
netsh advfirewall firewall add rule name="云端渲染-编码器UDP" dir=in action=allow protocol=udp localport=47998-48000

# ③ WebRTC 媒体传输
netsh advfirewall firewall add rule name="云端渲染-WebRTC" dir=in action=allow protocol=udp localport=40000-40100
```

> **最小开放方案**：如果只需要远端管理 + 串流，至少开放 **9000（TCP）+ 8080（TCP）+ 47984/47989/48010（TCP）+ 47998-48000（UDP）+ 40000-40100（UDP）**。

### Windows Defender 建议

将应用目录加入排除列表，避免实时扫描拖慢解压速度：

1. 打开 Windows 安全中心 → 病毒和威胁防护 → 管理设置
2. 排除项 → 添加排除项 → 文件夹
3. 选择 `D:\stream-kit\apps\`

---

## 10. 浏览器兼容性

| 功能 | Chrome 94+ | Edge 94+ | Firefox 100+ | Safari 15.4+ |
|------|:----------:|:--------:|:------------:|:------------:|
| WebRTC 串流 | 支持 | 支持 | 支持 | 支持 |
| H.264 解码 | 支持 | 支持 | 支持 | 支持 |
| HEVC 解码 | 部分 | 部分 | 不支持 | 支持 |
| AV1 解码 | 支持 | 支持 | 支持 | Safari 17+ |
| 游戏手柄 | 需 HTTPS | 需 HTTPS | 需 HTTPS | 需 HTTPS |

---

## 11. 常见问题与排查

### ⓪ 启动后组件不自动拉起

- 检查 `config.json` 中 `components.sunshine.exe_path` 路径是否正确
- 检查 `auto_start` 是否为 `true`
- 查看 ⓪ 控制台输出的错误信息

### ⓪ 报 "端口已被占用"

端口 9000 被其他程序占用，或上一个 orchestrator 进程未退出。

```powershell
# 查找占用端口的进程
netstat -ano | findstr :9000
# 终止进程
taskkill /PID <PID> /F
```

### 上传应用后状态一直是"错误"

- 检查压缩包格式是否为 zip/tar.gz
- 检查压缩包内是否包含 `.exe` 文件
- 在应用详情页查看具体错误信息

### 应用注册到 Sunshine 失败

- 检查 `sunshine_api` 中的用户名密码是否正确
- 确认 Sunshine 正在运行（⓪ 仪表盘显示绿色）
- 点击应用详情页的 **「重试注册」** 按钮

### 串流按钮不可用

- 确认应用状态为「就绪」
- 确认串流编码器和串流网关都在运行（仪表盘绿色）
- 确认 Moonlight-Web 已完成初始配对（见第 5.3 节）
- 检查 `moonlight_web` 配置中的用户名密码是否正确

### 远端串流打不开

- 串流链接基于访问者当前使用的 IP/域名自动构建
- 确认防火墙已放行 8080（TCP）+ 47984-48010（TCP）+ 47998-48000（UDP）+ 40000-40100（UDP）
- 确认 Moonlight-Web 中主机地址配置为 `localhost`（不要用具体 IP，因为 IP 会变）

### 无法连接 Sunshine

```powershell
# 测试 Sunshine 端口连通性
Test-NetConnection localhost -Port 47989
```

### 查看详细日志

```powershell
# 控制台查看
.\orchestrator.exe  # 默认输出到控制台

# 日志文件
type .\logs\orchestrator.log | Select-Object -Last 50
```

---

## 12. 端口速查表

| 端口 | 协议 | 程序 | 用途 | 远端必须开放？ |
|------|------|------|------|:-------------:|
| **9000** | TCP | ⓪ Orchestrator | 管理界面（Web UI + API + WebSocket） | **是** |
| **8080** | TCP | ② 串流网关 | 串流页面 + WebSocket 信令 | **是** |
| **47984** | TCP | ① 编码器 | HTTPS API（配对/串流协商） | **是** |
| **47989** | TCP | ① 编码器 | HTTP API（应用管理/状态查询） | **是** |
| 47990 | TCP | ① 编码器 | Web UI 管理界面 | 可选 |
| **48010** | TCP | ① 编码器 | RTSP 会话建立 | **是** |
| **47998** | UDP | ① 编码器 | 视频流 | **是** |
| **47999** | UDP | ① 编码器 | 控制流 | **是** |
| **48000** | UDP | ① 编码器 | 音频流 | **是** |
| **40000-40100** | UDP | ③ streamer | WebRTC 媒体传输 | **是** |

> 远端用户通过 `http://<工作站IP>:9000` 访问管理界面，点击"启动串流"后系统自动用工作站 IP 构建串流链接。

---

## 附录：串流参数调优

在 Moonlight-Web 串流界面的设置中可调整：

| 参数 | 默认值 | 建议 |
|------|--------|------|
| 码率 | 10000 kbps | 局域网 20000~50000，公网 5000~10000 |
| 帧率 | 60 | 30 / 60 / 120 |
| 分辨率 | 1920×1080 | 匹配显示器 |
| 视频编码 | H.264 | H.264 兼容好；HEVC/AV1 画质更高 |
| 传输模式 | auto | auto 优先 WebRTC |

---

> **版本**：Stream-Kit Orchestrator v1.7
> **日期**：2026-03-30
