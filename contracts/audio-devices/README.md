# 音频设备目录 v1

统一管理页通过控制面读取媒体网关所在 OS 用户上下文的真实音频端点。只枚举、不打开音频流、不修改默认设备。设备可见与虚拟设备配对、目标程序已录音是不同状态。

## 边界与接口

- 管理员：`GET /api/v1/audio-devices`，使用现有管理 JWT。普通观看连接、媒体票据和匿名请求不能读取设备拓扑。成功为现有 `{status:"ok", data:...}` 包装；网关未配置或读取失败返回 503，而非空列表成功。响应 `Cache-Control: no-store`。
- 控制面到网关：`POST /internal/v1/audio-devices`，保留网关 URL 前缀；复用 `media_ticket_secret`，请求和响应均使用 `X-Stream-Control-Signature`。该密钥不发送到浏览器，HTTP 重定向禁止跟随。
- 请求签名：HMAC-SHA256，输入为 UTF-8 `stream-kit/audio-devices/request/v1\n`（末尾实际换行）加原始 JSON 字节；响应域为 `stream-kit/audio-devices/response/v1\n`。结果为 64 个十六进制字符。与媒体状态/媒体票据分域，不能相互替代。

请求：

```json
{"schema_version":1,"request_id":"0123456789abcdef0123456789abcdef","issued_at_ms":1700000000000}
```

`request_id` 为每次请求新生成的 16 字节安全随机数的十六进制编码。网关限制请求为 2048 字节，拒绝未知字段，接受不早于本机 5 秒、不晚于本机 2 秒的时间戳。认证失败 401；格式/版本/时间错误 400；枚举繁忙或平台不可用 503。此只读请求不维护重放缓存；控制面通过随机请求标识绑定响应，旧响应不能满足新请求。

响应：

```json
{
  "schema_version":1,
  "request_id":"0123456789abcdef0123456789abcdef",
  "request_issued_at_ms":1700000000000,
  "observed_at_ms":1700000000020,
  "devices":[{"id":"wasapi:example","name":"Example output","input":false,"output":true}],
  "configured_routes":[{"host_id":123,"app_id":456,"endpoint":{"render_device_id":"wasapi:example","capture_device_id":"wasapi:example-capture"}}]
}
```

控制面先验证响应签名，再严格解码 JSON：限制 1 MiB、拒绝未知字段/尾随 JSON、验证版本、完整请求标识与时间绑定、观测时钟偏差和 5 秒最大往返时效、非空数组字段与唯一非空设备标识。设备集合本身允许零项。配置端点允许当前不可见，这正是管理页需要呈现的信息。

## 资源与生效语义

- 网关原生枚举在阻塞任务执行，不阻塞异步媒体执行器。全进程单次枚举限额；即使 HTTP 取消，运行中的原生调用仍持有限额，不会产生无限排队任务。
- 控制面复用现有 2 秒超时 HTTP 客户端，不持有媒体状态发布锁，不影响控制权租约续期。
- 管理页由管理员显式读取/刷新，无周期性设备扫描。刷新失败清除旧目录并显示错误，避免把旧数据当作新状态。
- `configured_routes` 是网关当前进程已加载的 `local_audio_targets`，不代表持久化动态路由或运行中的设备已打开。本版本不增加修改路由接口；静态路由仍需重启网关加载。设备方向和缺失状态在管理页标出，不依据名称自动配对。
- 运行中的实际设备状态沿用 [媒体状态协议](../media-state/README.md)。设备是否打开不证明目标应用已收到麦克风。

## 验证

Go 测试覆盖请求/响应签名、随机标识/时间/版本、篡改、域隔离、尾随/超大响应、错误密钥、重定向、设备重复、管理权限和枚举不占用状态发布锁。Rust 测试覆盖请求认证与时效，既有媒体状态签名 fixture 保持一致。

```text
node scripts/smoke-media-contract.cjs GATEWAY_EXECUTABLE [ORCHESTRATOR_EXECUTABLE]
```

单网关测试将本机 CLI 枚举结果与 HTTP 可用状态对照；无音频服务的无头环境必须明确返回 503。提供控制面程序时执行真实浏览器登录、Go→Rust 签名调用、设备列表/缺失绑定、无自动轮询和桌面/窄屏布局验收，此模式要求原生音频上下文可用。

2026-10-30 Windows 11 本机验收通过：网关 126 项测试与严格 Clippy、Go 全量测试及 vet、Windows 构建、Windows 上的 Linux amd64 控制面交叉编译、管理 Web 构建。真实 Chrome 155 经隔离管理进程读到 5 个 Windows 端点；两个故意不存在的配置端点显示缺失，未打开播放/录音流，未启动渲染应用。证据：`artifacts/media-contract/win32-x64/result.json`、同目录两张音频页面截图；`artifacts/web-ui-review/` 的 18 张布局检查通过。本次未执行 Linux 或手机真机验收，也未更新现有 9000/8080 常驻服务。

动态端点配置、专用 Windows 虚拟设备部署及浏览器→UE5/录音机实际录音仍需完成，不计入本次通过范围。
