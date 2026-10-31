# 跨节点麦克风目标：集成契约

## 当前实现和交付边界

会话目标、节点目录、自动授权发布、源网关发送、接收节点输出及管理页面已接入同一实现。Windows 已完成受控浏览器音源经本机目标和独立接收网关两条路径进入 VB-CABLE 原生录音的验证，详见 windows-recording-20261031.json。两条路径均检查观众拒绝、当前控制者、旧控制者拒绝、新控制者和释放控制权后的录音。远端模式使用同机回环网络，不代表跨机器 TLS／WAN、物理麦克风权限或 UE5 运行验收。

## 会话与设备模型

会话 audio.target 支持 disabled、upstream、local、remote 四种模式。remote 必须指定 node_id、render_device_id 和 capture_device_id；节点 ID 来自管理员已生效的 render_nodes 配置，禁止使用保留 ID primary。其余模式不携带 node_id。local 与 remote 均需明确端点对，不回退系统默认设备。

同一节点上的端点不能被多个未停止会话重复占用；不同节点可以有相同设备 ID。目标保存复用 expected_epoch 比较更新、持久化和事件通知；切换或重新应用均推进目标代次。控制者变化使用独立 control_epoch，物理连接重新附着也不能继承旧发送器。

管理页在会话的“目标程序麦克风”中选择节点并读取该节点的签名设备目录。切换节点清除旧目录与端点选择，迟到的查询不能覆盖新节点结果。目标配置实时应用；节点地址、名称与专属管理密钥仍需管理服务重启生效。

## 节点身份和授权

POST /internal/v2/audio-devices 的签名响应包含设备、配置端点及 instance_id。启动 ID 在音频进程内随机生成，重启更换，不继承服务监管的关联 ID。控制面严格验证签名、请求随机标识、时效和实例格式。远端使用 HTTPS；回环地址允许 HTTP。节点密钥互不共用，不发送给浏览器。

控制面每个已配置节点使用独立续期任务，仅有 remote 会话或待撤销授权时请求节点；设备目录用于首次识别实例或实例失效后的重新识别，不做每秒设备扫描。独立任务避免离线节点阻塞主媒体租约与其他节点。

先向接收节点 POST /internal/v1/node-audio-state，签名域为 stream-kit/node-audio-state/request/v1 和 response/v1，各以实际换行结尾。外层绑定节点和启动实例，内层复用 v3 会话快照。接收投影将该节点的 remote 目标转换为本机 local 端点；最多 64 个授权绑定。仅有效控制者、未禁麦、未过期连接可进入绑定。原子替换与空快照撤权复用同一授权锁，单调时钟期限防止时钟回退延长已有租约。样例见 node-state-v1.fixture.json。

收到接收节点签名确认后，控制面从该节点专属管理密钥派生 STREAM-MICROPHONE 的 HS256 密钥，签发 5 秒单次建连凭据。绑定源节点 primary、目标节点及启动实例、会话、连接、host/app、目标和控制代次。样例见 remote-microphone-v1.fixture.json。

随后向源网关 POST /internal/v1/node-microphone-route，使用源网关专属密钥及 stream-kit/node-microphone-route/request/v1、response/v1 签名域（末尾实际换行）。请求包含 schema_version、issued_at_ms、expires_at_ms、binding、url、token。源网关从已验证的媒体状态和真实附着表重新确认控制者；在连接建立后再次检查，不能凭路由请求本身越权。相同绑定续期既有连接，不重复使用票据建连；代次、端点、附着变化或租约失效关闭旧连接。

## 音频路径与资源生命周期

源网关保持唯一上游及原有观众混音。混音器单独输出控制者麦克风 PCM，在既有授权锁内非阻塞提交到 Sender；不会把程序声音重复送进目标输入。观众接收与目标连接故障相互独立。

接收入口为 WebSocket GET /internal/v1/node-microphone/{session_id}，只从 Authorization Bearer 读取票据，要求原生 TLS 或回环连接。连接使用系统根证书验证，不复用 Sunshine 配对客户端的特殊证书逻辑。localhost 的明文连接仅拨号到已解析的回环 IP；远端明文、URL 凭据、查询和片段均拒绝。

SKM1 每帧固定 7716 字节：magic、目标代次、控制代次、序号、原始采集 Unix 毫秒及 1920 个 float32 样本（48kHz 双声道 20ms）。网络队列最多一帧，满额不阻塞混音器；发送前、接收后和原生回调都限制原始年龄小于 60ms。时钟转换向保守方向取整，不重写时间延长旧语音寿命。两节点时钟需同步。

接收进程共用单次凭据消费表，最多 4096 个有效记录、16 个打开中或活动连接；设备打开失败仍消费票据。设备与本机目标、主动配对测试共用 EndpointRegistry。打开、接收及关闭在阻塞工作线程执行，逐帧持授权读锁提交，无数据时每 20ms 检查租约。非法帧、断连、撤权和任务释放均清空并关闭设备。源会话驱动退出也释放远端连接。

## 运行反馈与已有证据

管理页区分 pending、device_failed、remote_transport 等状态。remote_transport 只表示传输已连接；实际录音仍需目标应用验证。控制面路由错误显示在会话状态，不仅输出日志。

此前原生接收入口和授权 HTTP 验证见 artifacts/media-contract/win32-x64/run-0d624L/result.json；发送模块真实回环 WebSocket 定向检查见 .local/validation/node-sender-tests.log。本次会话集成完成相关 Go 包回归、源端控制者/代次定向测试、网关编译与静态检查、管理页生产构建和目标节点选择保存浏览器检查，结果位于 .local/validation/remote-route-tests.log 和 artifacts/session-audio/admin-browser-result.json。浏览器页面采用模拟 API；这些证据不等于两台真实服务器和 UE5 完成录音。

当前已验证发布构建的本机及独立接收网关原生录音，以及观众同时收到程序音和受控浏览器麦克风音。剩余重点为实际物理麦克风和 UE5 场景、跨机器部署、Windows 服务身份运行及安装升级交付。4 小时长稳已按用户确认完成，不再补跑 24 小时；Linux 和移动端本轮无需真机验收。
