# 渲染节点音频目标适配

此组件将会话总线输出的麦克风 PCM 写入明确指定的本机播放端点，供虚拟声卡另一侧的录音端点被目标程序采集。它不把程序声音送回录音端点，不切换默认设备，不安装驱动，不运行 AudioRelay，也不使用设备名称猜测或默认设备回退。

平台 I/O 统一封装在锁定版本的 [CPAL 0.18.2](https://github.com/RustAudio/cpal) 后面：Windows 使用 WASAPI，Linux 启用 PulseAudio 和 ALSA。当前输入格式为每帧 20ms、48kHz、双声道 f32；设备侧支持 48kHz 单/双声道 f32、i16、i32，单声道进行双声道平均。申请不超过 20ms 的设备回调缓冲；不支持该格式的设备明确返回错误，重采样适配仍需扩展。

PCM 队列预分配三个槽位；过期 60ms 的数据不播放，满队列覆盖最老帧。实时回调不分配或释放堆内存，不阻塞等待锁，不记录日志；资源暂不可用时输出静音。控制者切换、禁麦或会话授权失效时清空队列。设备失效会停止接受数据；可恢复的 underrun 与实时调度权限不足单独计数，不能被误判成永久故障。

`TargetStatus` 的设备采样计数包括静音；设备打开或回调运行**不证明目标程序已经录到声音**。端点之间实际连通性、目标程序选用的输入设备、回声和延迟必须单独验收。

## 网关集成

由新编译的网关执行 `web-server audio-devices` 获取稳定设备 ID。只枚举，不打开采集/播放流。Linux 需在拥有图形/音频会话权限的用户上下文执行；不能拿 Windows 服务 Session 0 或任意 Linux system service 的默认设备代替目标用户的端点。

在网关配置中显式设置：

```json
{
  "local_audio_targets": [
    {
      "host_id": 123,
      "app_id": 456,
      "endpoint": {
        "render_device_id": "pulseaudio:provisioned_virtual_sink",
        "capture_device_id": "pulseaudio:provisioned_virtual_microphone"
      }
    }
  ]
}
```

示例 ID 是配置占位值，必须换成实际枚举结果。Windows 使用枚举出的 `wasapi:...` ID。必须由已部署的专用虚拟设备提供两端，目标程序也必须配置为使用该录音端点。填写任意两个物理设备不能建立虚拟连线。

每个 host/app 绑定独立端点，重复应用、重复播放或录音端点被拒绝。`local_audio_targets` 仅用于网关与渲染程序位于同一个节点的部署，Sunshine 主机地址必须是明确的回环 IP。远端主机的麦克风不能误写到网关本机；远端节点路由/安全传输、动态端点分配与统一管理页尚需继续实现。当前静态路由配置需重启网关生效，已有控制权、广播和禁麦策略仍使用实时签名状态。

已配置端点不可用时，上游启动返回 HTTP 503，不启动应用也不回退到默认扬声器。未配置本机端点时，网关仍支持控制者麦克风混音广播；只有上游实际支持 Foundation 麦克风扩展时才尝试原协议上行。管理端仍需完善“广播正常/目标不可用”等独立状态呈现，不能以浏览器麦克风功能可用推断目标录音完成。

## 验证

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo run --locked --example devices
# 该命令会向明确指定的端点播放测试音，并打开对应录音端点：
cargo run --locked --example verify_pair -- RENDER_DEVICE_ID CAPTURE_DEVICE_ID
```

Linux 安装 Ubuntu 官方 `build-essential pkg-config libasound2-dev libpulse-dev pulseaudio pulseaudio-utils` 后，在仓库根目录运行 `sh scripts/test-audio-target-linux.sh`。脚本启动独立用户 PulseAudio 实例，只加载虚拟 sink/source 和限定在私有目录内的 Unix socket，不加载硬件模块或 TCP listener，不更改现有服务及系统默认设备。结束时停止自己创建的进程，结果保存到 `artifacts/audio-target/`。PulseAudio 虚拟端点机制参见[官方模块文档](https://wiki.freedesktop.org/www/Software/PulseAudio/Documentation/User/Modules/)。

2026-10-30 本机证据：Windows 与 Ubuntu 26.04/WSL 的组件测试和严格 Clippy 检查通过；Linux 隔离虚拟端点录到了 150 包发送的 997Hz 测试信号。WSLg 现有 Pulse 服务枚举返回协议错误，不能把隔离测试当作该服务已兼容的证据。Windows 当前仅枚举到 Realtek/ToDesk，未配置项目专用虚拟录音设备，也没有据此改动现有设备或驱动。浏览器→网关→目标录音端点、Windows 实录、UE5 实录与生产音频质量验收尚未完成。
