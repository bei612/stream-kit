# UE5 原生录音接收验证

这是开发验收工程，不属于客户安装载荷。它不修改业务 UE 工程，不提供测试地图，也不替代平台服务。已在本机官方 UE 5.3.2 SDK 和 MSVC 工具链编译、运行。

使用引擎自身的 [FAudioCapture](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/AudioCaptureCore/FAudioCapture) 读取明确指定的输入端点。设备按稳定 ID 选择，缺失时失败，不回退系统默认麦克风。5.3 的设备信息查询使用全设备索引，打开录音流使用输入设备子集索引，两者分别解析。录音最多十秒，PCM 只在内存保留，实时回调使用预分配缓冲，不写文件、不分配、不等待锁。

开发机先构建独立工程目录：

```text
node scripts/build-ue5-audio-probe.mjs ENGINE_ROOT NEW_BUILD_DIRECTORY
```

需要修改开发探针时可附加 `--update`，构建器会核对上次引擎、模块散列和源文件快照，只更新自己创建且未被外部修改的源码，再交给 UnrealBuildTool 增量编译；不会反复复制 SDK 或生成多份 PCH。Node、.NET SDK、UnrealBuildTool 都是开发工具，不是平台安装依赖。

对已部署的专用虚拟设备对执行验收：

```text
node scripts/accept-ue5-audio.cjs UE_EDITOR_CMD COMPILED_PROBE_PROJECT AUDIO_PROBE RENDER_DEVICE_ID CAPTURE_DEVICE_ID NEW_EVIDENCE_DIRECTORY
```

脚本先确认 CPAL 和 UE5 的输入 ID 对应同一端点，测静音基线，再向明确指定的虚拟输出播放 997 Hz 测试音，由 UE5 录取并测量。采集启动后固定预热 250 ms，再通知发送方开始；启动阶段的不连续标志独立记录，测量期间出现不连续、丢帧、无效格式或关闭失败仍判失败。不调整系统默认设备、不打开物理麦克风、不录制语音文件、不安装驱动，也不打开编辑器窗口。

此验收证明专用虚拟输入可被真实 UE5 AudioCaptureCore 录取；它不单独证明浏览器语音回传、多人混音、跨机器连接或业务 UE 项目已经接入。完整媒体链路由平台验收分别证明，不能用本测试的成功替代。
