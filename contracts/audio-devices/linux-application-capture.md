# Linux 程序音频采集实施状态

`third_party/sunshine/src/platform/linux/application_audio.cpp` 实现现有
`platf::application_microphone` 接口，复用视频与音频共享的 `capture::target_t`。
PulseAudio 播放流必须属于目标进程；每个播放流单独设置 monitor stream，
然后混入 Sunshine 的 PCM 输出。不移动应用播放流、不修改默认设备，
不回退到整机声音。播放流发现周期为 250 ms，最多 64 路，PCM 队列上限
60 ms；消费线程停顿超过该时长后重新打开监听流，丢弃服务端积压。
目标退休或退出后关闭监听，不继续输出旧音频。

底层使用 [PulseAudio 的单播放流监听接口](https://freedesktop.org/software/pulseaudio/doxygen/stream_8h.html)，
不增加新的音频服务依赖。PipeWire 的 PulseAudio 兼容服务仍需实际验证。

## 尚未打通的产品路径

Linux 的 `capture::bind_application`、窗口视频捕获和程序输入坐标尚未实现。
因此保留 `process.cpp` 对 Linux application 模式的拒绝，不能将此后端提交
描述为 Linux 程序级串流已交付。下一步必须接通这些接口，再从统一管理端启动
应用并验证画面、音频和控制权，不能只以构造成功作为验收结果。

## 验证

本次在 Windows 原生 UCRT 编译器下，使用真实项目头文件及 PulseAudio 上游
头文件对后端和测试体执行 C++23 语法/API 检查，通过；这不是 Linux 编译、链接
或运行验证。Linux 真机验收本轮豁免不等于源码可免于 Linux 构建验证。

Linux 集成测试使用显式隔离 PulseAudio 实例，不使用系统默认音频设备：

```sh
sh scripts/test-audio-target-linux.sh /absolute/path/to/cmake-build-sunshine/tests/test_sunshine
```

`LinuxApplicationAudio.*` 包括非法目标拒绝、真实播放流排除、目标进程音频接收、
目标退休后停止并清空输出。隔离用例启动独立 `pacat` 进程播放 1477 Hz，
先从测试设备监听源确认它确实发声，再验证目标程序的 997 Hz 音频可接收且
1477 Hz 没有混入。未指定测试服务时，真实音频用例明确跳过。

音频 PCM 接口位于 `src/platform/audio_capture.h`，不依赖图形窗口、视频编码器
或全局服务配置。`tools/sunshine-audio-tests` 直接编译生产后端和同一个测试源文件，
不使用替代实现。仓库工作流中的 `Linux application audio (native PulseAudio)`
任务在 Ubuntu 24.04 上构建并执行此测试；独立入口为：

```sh
cmake -S tools/sunshine-audio-tests -B .local/cmake-build-linux-audio -G Ninja
cmake --build .local/cmake-build-linux-audio --parallel 2
sh scripts/test-audio-target-linux.sh --application-only "$PWD/.local/cmake-build-linux-audio/test_sunshine"
```

当前 Linux CI 尚待 runner 执行，没有编译或运行通过的证据，不能记为通过。
这项原生音频测试也不能替代整个 Sunshine 的 Linux 构建和程序串流端到端验收。
