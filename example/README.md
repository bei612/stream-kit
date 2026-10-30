# Stream Kit 综合测试程序

Windows 原生窗口保留棋盘格、分辨率与全屏测试，并增加实时画面计数、键盘/画布鼠标计数和音频测试面板。窗口缩放、关闭按钮和 Esc 均可使用；焦点在音频控件时 Esc 仍关闭整个程序。

## 音频测试

1. 选择输入设备，点击 **Record input**。页面显示实际采集帧数、峰值、RMS 和丢帧数。录音最多 10 秒，自动停止，也可提前点击 **Stop**。
2. 选择输出设备，点击 **Play recording** 回放刚才采集的声音，或点击 **Play test tone** 播放 3 秒 997Hz 测试音。回放增益为 0.5，测试音峰值为 0.08，首尾渐变。
3. 验证 Web 麦克风到目标程序时，将管理会话的麦克风目标配置为已部署的专用虚拟设备；在本程序中选择对应的录音输入。观察电平和回放结果，不能仅凭设备目录可见判断收音成功。

默认不选择输入/输出、打开麦克风或修改默认音频。录音只保存在内存中，新录音替换旧录音，关闭即释放。每次只运行一个录音或播放测试，避免回放自行再次录入。设备失败显示错误，需要显式重试。

自动验收可显式传入 `"--tone-output=设备名称或稳定 ID" --tone-count=2`。名称必须唯一匹配，缺失或歧义会显示错误，不回退到默认设备；每次播放仍为 3 秒，次数限定为 1–20，默认一次。点击任一音频操作会取消后续自动播放，点击 Stop 同时停止当前测试。该参数只播放测试音，不打开麦克风。

原生音频由 `components/audio-target` 中的 `audio-probe` 执行，复用锁定的 CPAL/WASAPI/PulseAudio/ALSA 技术栈。它是 example 自己的子进程，通过继承的标准输入输出通信，无端口或后台服务；关闭窗口、父进程退出或管道断开会释放设备。程序声音属于 example 的进程树，后续程序隔离采集必须包含该树。音频组件支持 Windows/Linux 构建，当前图形测试窗口使用 Win32。

## 构建与验证

在原生 Windows 的 Go、Rust、MSVC 环境运行 `example/build.ps1`。生成 `artifacts/example/checkerboard.exe`、`audio-probe.exe` 和包含二者的 `example.zip`，上传时两个程序必须在同一目录。参数仍支持 `-fullscreen` 与棋盘列/行数。

- `example/smoke-test.ps1`：真实窗口、设备列表、未选设备错误、停止、缩放、关闭、子控件 Esc 及音频子进程退出。
- `node scripts/test-example-audio.cjs`：真实原生设备枚举、协议/设备校验、无默认设备回退、管道关闭退出。
- `node scripts/accept-source-stream.cjs --sunshine <源码构建的 sunshine.exe> --gateway <源码构建的 web-server.exe> --orchestrator <orchestrator.exe> --example <checkerboard.exe> --example-output <明确的输出设备>`：在独立回环端口启动编码器，经管理接口注册程序采集，由两个真实浏览器验证共享画面、程序测试音和按实例停止；加 `--microphone-tone` 同时验证 1499 Hz 浏览器测试麦克风与 997 Hz 程序音的混音和撤权。完整结果、帧图像和日志写入 `artifacts/source-stream/`。
- `cargo test --locked --all-targets` 与 `cargo clippy --locked --all-targets -- -D warnings`（组件目录）：录音缓冲上限、PCM 电平、测试音及输出幅度与既有目标队列检查。

源码链路验收还支持 `--stop-active` 或 `--delete-active`：保留一个浏览器正在播放时执行管理停止或删除，检查观看会话终止、旧凭据拒绝、传输关闭，并持续观察 12 秒确认浏览器没有重新启动程序。删除用例只删除测试创建的注册与平台文件，同时核对外部 example 可执行文件的哈希保持不变。

2026-10-30 Windows 11 窗口与协议冒烟通过，三个窗口用例均正常退出且没有遗留音频子进程，设备数量以实时枚举为准。初始冒烟不打开麦克风或扬声器。后续完整源码链路使用明确选择的输出设备播放测试音，两个浏览器收到独立窗口、程序音及授权客户端测试麦克风混音；越权、转移和释放检查通过，证据位于 `artifacts/source-stream/2026-10-30T15-12-01-729Z/`。浏览器麦克风采用 Chromium 测试音源，没有打开现场物理麦克风；Web→虚拟输入→example/UE5 实录仍待验收。

## 内部管道协议 v1

每行一个 JSON 命令，最大 16KiB：`{"schema_version":1,"id":1,"op":"capture","device_id":"枚举所得稳定 ID"}`。操作为 `devices/status/capture/tone/playback/stop`。响应携带相同 `id`，主动状态事件的 `id` 为 0；两者包含 `schema_version/event/data` 或 `error`。状态事件最高 10Hz，仅测试运行时发送。录音内存预分配，原生回调不分配、不等待锁、不输出日志；控制队列有界，输入结束终止进程。

录音停止后可发送 `{"schema_version":1,"id":2,"op":"analyze","frequency_hz":1499}`，分析已录 PCM 中的客户端测试音；再次指定 997 Hz 可检查程序音是否混入目标录音输入。结果包含采样率、分析帧数、窗口数、峰值和平均幅度。分析使用 100 ms Hann 窗口，接受 20–20000 Hz、100 ms–10 秒录音，不打开设备，不改变录音，只在显式请求时运行；活动测试期间拒绝分析。峰值可识别短时测试音，平均值包含静音窗口；结果本身不自动判定端到端通过，也不能替代真实目标端录音与撤权后静音检查。

2026-10-31 新增分析的 13 项组件/探针测试、严格 Clippy、Windows 构建和原生管道验证通过。模拟 PCM 测试覆盖客户端 1499 Hz 与程序 997 Hz 分离、幅度、静音、短时信号、非法频率及容量限制。实时枚举仍仅发现 Realtek/ToDesk 输入输出，本轮没有打开这些设备或更改默认设备，未取得专用虚拟录音端点的端到端接收证据。
