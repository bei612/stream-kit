# 管理事件连接 v1

管理事件属于现有单管理员身份边界，观看邀请、客户端连接凭据和媒体票据不能订阅管理事件。不增加观看者账号、权限角色或独立认证服务。

## 握手

- 地址：同源 `GET /api/v1/ws`，HTTPS 页面使用 WSS。禁止用 URL 查询参数传递凭据。
- 浏览器发送 `Sec-WebSocket-Protocol: stream-kit.events.v1, stream-kit.auth.<management JWT>`。版本必须存在，凭据只能出现一次；认证仍由 REST 共用的管理 JWT 验证器执行。
- 服务端只协商返回 `stream-kit.events.v1`，不回显认证值。不应在代理或应用日志中记录认证请求头。
- 非浏览器客户端可沿用 `Authorization: Bearer <management JWT>`。
- 服务端保留同源 Origin 校验，连接不能超过管理凭据有效期。旧的 `?token=` 接入不再认证；前后端应协调升级。

## 事件和恢复

消息继续采用 `{ "type": "stream_controller_changed", "data": ... }` 结构，各领域保留现有事件名和数据。事件用于触发管理页重新查询权威状态，不是授权凭据，不直接决定客户端控制权；控制权与音频运行授权仍以独立的签名媒体状态协议为准。

连接最多 20 个，每连接队列最多 64 条。队列写入、移除和关闭由 Hub 统一持有，消费端只有只读出口。慢连接直接移除，避免积压清理任务；不提供历史事件重放。前端在连接建立或恢复时刷新订阅查询，以补齐断线期间的状态变化。

前端每个管理页仅持有一个有效连接及一个重试计时器，旧连接的迟到事件不能修改替代连接。重试退避为 1 秒起、上限 30 秒；退出、页面卸载或凭据到期取消重试并释放连接。服务端关闭时释放 Hub 中的连接。

## 验证

- `go test ./internal/ws ./internal/server/...`：真实 HTTP/WebSocket 握手、URL 凭据拒绝、观看凭据隔离、重复凭据拒绝、Origin、到期断开、事件投递、容量、慢连接与并发关闭。
- `node --test scripts/test-management-websocket.mjs`：重复连接、凭据替换、旧事件竞争、退避、过期、退出和构造失败。
- `node scripts/accept-management-websocket.cjs <新构建 Orchestrator 路径>`：隔离配置和数据库，使用生产 Web 产物与真实 Chrome，验证登录、唯一有效连接、事件投递、控制进程重启后恢复及退出释放。不会启动 Sunshine、UE5 或其他应用。

Linux CI 增加 `go test -race ./internal/ws ./internal/server/...`；配置检查不代表远端 CI 已通过。Linux 本轮仅需适配与编译/自动化，不要求实机验收。
