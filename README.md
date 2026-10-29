# Stream-Kit 使用手册

> 本手册面向在 Windows 环境下部署和使用 Stream-Kit 的用户。
> Stream-Kit 通过 ⓪ Orchestrator 统一管理串流服务，实现应用的上传、部署和浏览器远程串流。

## 本地源码构建与验证（2026-10-26）

本目录已建立独立 Git 仓库，默认分支为 `main`。`docs/src` 中三个上游项目按当前源码快照保存；导入资料没有原 Git 元数据和确定的上游提交号，`.gitmodules` 中的地址仅保留来源信息，不代表已建立可更新的 Git 子模块。Go 的 `vendor` 目录随源码保存。运行配置、数据库、上传应用、依赖安装目录、编译产物和验证截图不进入版本管理。

## 单仓源码纳管（2026-10-29）

三个上游项目已直接纳入 `third_party/`，不使用 Git 子模块：Sunshine `v2026.914.233613`、Moonlight-Web-Stream `v3.0.1`、Moonlight-Qt `v6.2.0`。版本、commit 和许可证记录在 `third_party-manifests/upstream-lock.json`。Moonlight-Web-Stream v3.0.1 已包含浏览器麦克风采集和 WebRTC 上行基础能力。

Orchestrator 已增加渲染会话管理基础层：会话登记、客户端连接/心跳/断开、唯一控制者、音频配置、会话策略和管理 WebSocket 事件。接口位于 `/api/v1/stream-sessions`。当前这些接口已经可以供后续 Web 网关接入；媒体层的单一渲染会话复用、服务器端音频混音和多客户端音频广播仍需接入 Moonlight-Web-Stream 的媒体循环后才算完整交付，不能把当前阶段描述为已完成麦克风广播。

构建需要 Git、Go（至少 1.25）和 Node.js/npm 在当前终端的 PATH 中。本次实际使用 Go 1.27.3、Node.js 24.22.0、Git 2.56.0.windows.3。以下命令在仓库根目录执行；PowerShell 的执行策略仅对启动的脚本进程生效：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File orchestrator/build.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File example/build.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File example/smoke-test.ps1

Push-Location orchestrator
go test -mod=vendor ./cmd/... ./internal/...
Pop-Location
```

管理端产物为 `orchestrator/dist/orchestrator.exe`，配套页面在 `orchestrator/dist/dist`。example 产物为 `artifacts/example/checkerboard.exe`，可上传包为 `artifacts/example/example.zip`。直接运行 example：

```powershell
& ./artifacts/example/checkerboard.exe
& ./artifacts/example/checkerboard.exe 12 6
& ./artifacts/example/checkerboard.exe -fullscreen 10
```

`example/smoke-test.ps1` 会临时打开测试窗口，验证棋盘颜色、绿色边框、窗口标题、缩放及正常退出，并将截图和 JSON 结果保存到 `artifacts/example`。

本次验证结果：

- 管理端前端与 Windows x64 后端编译通过，Go 测试通过。
- example 默认 8×8、自定义 12×6、全屏 10×10 均正常绘制并以退出码 0 关闭；本机全屏客户区为 3440×1440。已修复默认窗口说明文字裁切问题。
- 修复 Windows 上对 `/file`、`\file` 等根路径归档条目的校验，并补充回归用例。
- 使用独立配置和数据库验证管理端健康接口、登录保护、浏览器登录、应用列表、详情页和管理 WebSocket；无浏览器未捕获异常。新编译的 example.zip 上传、解压、入口识别通过，解压 EXE 与构建 EXE 字节一致。
- 首轮管理端测试关闭了外部串流集成；随后已完成下述实际串流部署和验证。上游运行组件使用经过哈希校验的官方发行二进制，没有将它们描述为本次从上游源码编译的产物。

管理端自动验证脚本为 `orchestrator/smoke-test.cjs`。它要求已经启动一个监听 `127.0.0.1`、关闭 Sunshine/Moonlight 集成的独立测试实例，接收配置文件路径作为参数，并依赖 Playwright 和 Chrome。可通过 `PLAYWRIGHT_MODULE` 环境变量指定已有 Playwright 模块路径。脚本只将无凭据的检查结果和截图保存到 `artifacts/orchestrator`；测试配置及数据库应放在被忽略的 `.local` 目录。

本机实际串流部署（2026-10-26）：

- Sunshine `v2026.914.233613` 位于 `.local/sunshine/Sunshine`；Moonlight Web `v2.10.0` 位于 `.local/moonlight/package`。发行版下载地址及 SHA-256 固定在 `scripts/local-components.json`，可运行 `scripts/download-local.ps1` 下载并校验。运行组件版本与 `docs/src` 中保留的历史源码快照应区分。
- 管理页为 `http://127.0.0.1:9000`，串流网关为 `http://127.0.0.1:8080`，Sunshine 管理页为 `https://127.0.0.1:47990`。三个服务目前均绑定本机地址，尚未配置局域网或公网访问。
- 本机管理员账号在 `.local/runtime/credentials.json`，管理端实际配置在 `.local/runtime/config.json`；这些文件不进入 Git。管理端负责启动、监控 Sunshine 和 Moonlight，首次配对已完成。串流网关已启用原生默认用户 `local-viewer`（普通 User，禁止新增主机），打开串流链接无需登录；9000 管理端和 Sunshine 管理页仍需管理员密码。
- 已从浏览器管理页面完整走通“登录 → 启动 example → 网关登录 → WebRTC 视频 → 鼠标回传 → Esc 退出”。实际视频为 H.264 1280×720，使用 RTX 5060 Ti NVENC；统计确认解码帧和 Opus 音频包到达。棋盘格不产生测试音，因此没有据此宣称听感或数字人音频验收完成。
- example 原先在串流启动后偶发无响应：Win32 窗口创建和消息循环必须处于同一操作系统线程，已通过 `runtime.LockOSThread` 修复。全屏窗口设为置顶以避免后台启动时被编辑器遮挡；点击画面取得焦点后可按 `Esc` 或 `Alt+F4` 关闭。管理端停止按钮也可结束程序。
- 已修复管理端把 `/serverinfo` 发往管理端口的问题，新增 `sunshine_api.server_info_url`，并拒绝将 HTTP 错误或缺字段响应当作空闲。JWT 密钥和网关密码也纳入配置脱敏。
- 远程视频、鼠标与退出验证记录在 `artifacts/streaming/live-results.json`，浏览器收到的帧截图在 `artifacts/streaming/received-frame.png`。

后续启动本机部署：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

`scripts/smoke-streaming.cjs` 可复测实际串流（需要 Playwright 模块和 Chrome，支持 `PLAYWRIGHT_MODULE` 环境变量）。它会启动全屏 example、移动鼠标并发送 Esc；应在允许短暂操作测试窗口时运行。`scripts/pair-local.cjs` 用于本机网关配对，读取上述本机账号文件，不输出密码或配对 PIN。

本机免密通过 `.local/moonlight/package/server/config.json` 的 `web_server.default_user_id` 指向普通用户实现，已配对的本机主机设为 Global 供该用户访问。配置及账号均保留在被 Git 忽略的运行目录。配置脚本只允许绑定 `127.0.0.1:8080` 的网关，会重启网关并验证匿名串流身份及管理接口权限：

```powershell
node scripts/configure-local-passwordless.cjs
# 恢复网关密码登录（default_user_id = null）
node scripts/configure-local-passwordless.cjs --disable
```

`node scripts/smoke-streaming.cjs --direct --video-only` 用全新浏览器会话验证原串流链接免密连接及视频解码，记录在 `artifacts/streaming/passwordless-results.json`，结束后停止测试应用。省略 `--video-only` 会进一步验证棋盘格、鼠标和 Esc。Windows 锁屏时串流会显示锁屏画面，须在本机解锁后才能验证 example 交互；网关免密不会解除 Windows 锁屏。

2026-10-26 晚间复测：Windows 已解锁，免密连接与棋盘格视频正常，但键鼠回传未通过，不能沿用此前完整交互通过的结论。网关及 Sunshine 日志均确认收到输入包；本机原生 `SendInput` 返回成功但鼠标坐标不变，`SetCursorPos` 则能改变坐标。待核查 Windows 模拟输入限制；现场 ToDesk 正在运行，但尚未确认它是否为原因。管理端停止应用正常，临时诊断日志级别已恢复。最新运行状态及失败原因记录在 `artifacts/streaming/latest-run.json`；历史 `live-results.json` 不能代替最新结果。颜色校验允许因缩放、留黑边导致深浅格采样顺序互换。

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
