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

Linux 的 `capture::bind_application` 已接进程组身份、X11 窗口选择及输入坐标/
焦点校验。`application_frame.cpp` 使用 XComposite 窗口 backing pixmap 与私有
MIT-SHM 缓冲采集客户区，接入现有软件、VAAPI、CUDA 编码适配器；不会转为桌面裁剪。
`process.cpp` 已接通启用 X11 的 Linux 启动路径，其他 Linux 图形后端仍拒绝 application 模式。
这属于源码实现，尚未通过 Linux 构建及完整串流验收，不能描述为已经交付。
仍需从统一管理端启动应用，验证画面、音频和控制权。

当前窗口像素支持 X11 本地服务、32 位 BGRX 布局和 TrueColor 视觉；依赖 Composite、
MIT-SHM、X-Resource，光标叠加使用 XFixes。窗口改变尺寸时重建采集，目标退休时清空输出并停止。
纯 Wayland 应用、非上述像素格式和 PipeWire 兼容行为未获验收。

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
目标进程则在另一个独立进程组播放 997 Hz。先从测试设备监听源确认两者确实
发声，再通过真实 `capture::bind_application` 验证目标音频可接收且 1477 Hz
没有混入；不再用模拟进程归属替代这一集成检查。未指定测试服务时，真实音频
用例明确跳过。

音频 PCM 接口位于 `src/platform/audio_capture.h`，不依赖图形窗口、视频编码器
或全局服务配置。`tools/sunshine-audio-tests` 直接编译生产后端和同一个测试源文件，
不使用替代实现。独立的 `linux-native-capture` 工作流在 Ubuntu 24.04 上构建
并执行此测试，运行中的验证不因后续 push 被取消；独立入口为：

```sh
cmake -S tools/sunshine-audio-tests -B .local/cmake-build-linux-audio -G Ninja
cmake --build .local/cmake-build-linux-audio --parallel 2
STREAM_KIT_TEST_X11_CAPTURE=1 xvfb-run -a sh scripts/test-audio-target-linux.sh --application-only "$PWD/.local/cmake-build-linux-audio/test_sunshine"
```

`bdbfd689` 和 `f159ddac` 的 Linux CI 已执行，原生编译步骤失败，音频运行步骤
未执行。`f159ddac` 的诊断确认 `fclose` 的函数属性触发 GCC 严格编译错误，
`9aa4cfd2` 已改用显式 FILE 释放器，未关闭编译警告。
后续版本尚须通过编译及运行测试，不能记为通过。
这项原生音频测试也不能替代整个 Sunshine 的 Linux 构建和程序串流端到端验收。

## 启动身份

Linux 后端保留 `/proc/<pid>/stat` 文件描述符，读取原任务的存活状态和进程组。
进程退出后不按数字 PID 重新打开身份；Linux 内核对这类保留描述符的语义见
[procfs 文档](https://www.kernel.org/doc/html/v6.15/filesystems/proc.html)。
入口要求启动根进程为独立进程组组长，禁止使用服务端自身进程组。
已有存活成员持续证明进程组归属，已保留的子进程可在启动器退出后继续授权；
离开进程组、进程退出或目标退休后拒绝采集。成员发现每 250 ms 至多执行一次，
最多保留 4096 个任务，捕获身份释放不会终止应用。

当前必须在根进程仍存活时绑定；如果所有已保留成员都退出而仅剩未发现后代，
后端会拒绝继续授权，不通过裸进程组数字恢复身份。这一限制尚须结合实际
Linux 渲染程序的启动方式验证。四项 `LinuxCaptureTargetTest` 使用真实子进程
覆盖进程组隔离、启动器退出、成员离组与身份失效，已接入同一个原生 CI 目标。

X11 窗口选择使用 X-Resource 扩展查询服务器报告的本地客户端 PID，再校验上述
进程身份。窗口标题及应用自行设置的 `_NET_WM_PID` 不作为归属证明；只选本次
启动组中的可见应用窗口，保持选择直到窗口或原进程失效，不选桌面根窗口。
新增 `IsolatesOwnedWindowPixelsAndInputUntilRetirement` 使用 Xvfb 和两个
独立进程组的同标题窗口验证选择、身份稳定、输入坐标、焦点切换与退出失效，
须以其实际运行结果验收。输入沿用统一 `capture::input_origin/input_focused`
接口；过期的窗口/画面尺寸不接受输入坐标，焦点必须位于所选窗口或其子控件。
该测试同时将目标窗口涂红并用绿色外部窗口遮挡，检查根画面确实为绿色、采集输出仍为红色，
以及尺寸变化、退休后的输出行为；测试已加入 CI，须等待实际运行结果。
Linux X11 构建增加 `xcb-res`、`xcb-composite`、`xcb-shm`、`xcb-xfixes` 开发依赖。
