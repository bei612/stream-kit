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
- 受管理模式的 `configured_routes` 来自当前有效权威租约中的本机目标配置；非受管理模式才读取静态 `local_audio_targets`。二者都不证明设备已打开。动态目标修改接口及实时生效见 [路由设计](routing-design.md)。设备方向和缺失状态在管理页标出，不依据名称自动配对。
- 运行中的实际设备状态沿用 [媒体状态协议](../media-state/README.md)。设备是否打开不证明目标应用已收到麦克风。

## 验证

Go 测试覆盖请求/响应签名、随机标识/时间/版本、篡改、域隔离、尾随/超大响应、错误密钥、重定向、设备重复、管理权限和枚举不占用状态发布锁。Rust 测试覆盖请求认证与时效，既有媒体状态签名 fixture 保持一致。

```text
node scripts/smoke-media-contract.cjs GATEWAY_EXECUTABLE [ORCHESTRATOR_EXECUTABLE]
```

单网关测试将本机 CLI 枚举结果与 HTTP 可用状态对照；无音频服务的无头环境必须明确返回 503。提供控制面程序时执行真实浏览器登录、Go→Rust 签名调用、设备列表/缺失绑定、无自动轮询和桌面/窄屏布局验收，此模式要求原生音频上下文可用。

2026-10-30 Windows 11 真实 Chrome 155 经隔离管理进程读取 5 个端点，验证目标保存、旧代次及缺失端点拒绝、桌面和窄屏布局；未打开播放/录音流，未启动渲染应用。证据及本批测试见 [路由设计](routing-design.md)。未更新现有常驻服务。

专用 Windows 虚拟设备部署及浏览器→UE5/录音机实际录音仍待验收。

## 端点对显式检查（网关内部接口）

网关提供 `POST /internal/v1/audio-pair-check`，请求必须使用 `stream-kit/audio-pair-check/request/v1\n` 签名域，响应使用独立的 `stream-kit/audio-pair-check/response/v1\n` 签名域。请求包含 `schema_version`、32 位十六进制随机 `request_id`、`issued_at_ms` 和 `endpoint` 的明确输出/输入 ID；服务端校验签名、时效、方向格式与不同 ID，并在本进程内拒绝重复 nonce。nonce 缓存随进程结束而清空，不能视为跨重启的持久防重放机制。

此操作会在指定输出播放测试音并打开指定输入进行测量，必须由管理员明确发起。网关对检查进行全局并发限额，使用与实时输出相同的端点占用登记；会话持有设备时检查失败，取消 HTTP 请求也不会提前释放运行中的原生任务及其占用。检查不更改默认设备。响应绑定原请求并包含基线静音、测试音、清空后静音、设备状态和测量结论。通过仅证明该端点对在检查时可传递测试音，不能证明浏览器上行或目标应用已录音。

统一控制面提供管理员认证的 `POST /api/v1/audio-devices/check-pair`，请求仅包含明确的 `render_device_id`、`capture_device_id`。控制面重新读取签名设备目录并校验方向，再发送一次签名检查请求；不自动重试。检查使用独立的 15 秒请求超时，不改变权威租约同步的短超时，不持有同步锁。响应严格验证签名域、请求绑定、时效和测量结构；声称通过的结果还必须包含测试音、静音和释放设备的必要证据。

管理页“服务器音频设备”中可显式选择端点并发起检查，运行期间禁用选择和重复提交；切换端点或刷新目录清除旧结果。`scripts/test-admin-audio-pair.cjs` 使用生产前端和受控 API 响应验证操作、失败状态及桌面/窄屏布局，不打开音频设备。Go 测试覆盖请求签名、响应域和绑定、假阳性拒绝、无效请求不触发操作。跨节点设备选择和真实虚拟设备验收仍未完成。
