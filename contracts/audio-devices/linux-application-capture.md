# Linux 指定程序采集后端

本文描述 X11 程序画面、进程音频及身份边界；不将后端源码存在视为所有 Linux 图形环境可用。当前发布和实际 Linux 页面证据见[发布基线](../../docs/release-status.md)。

## 程序画面

Sunshine 的 Linux application 后端使用共享 `capture::target_t` 身份，X11 启动路径绑定进程组、窗口和输入坐标/焦点。`application_frame.cpp` 使用 XComposite window backing pixmap 与私有 MIT-SHM 缓冲采集客户区，不是桌面裁剪。

当前支持本地 X11、32 位 BGRX 与 TrueColor，依赖 Composite、MIT-SHM、X-Resource，光标叠加使用 XFixes。窗口尺寸变化重建采集，目标退休清空输出并停止；不回退桌面。启用的 X11 后端可接现有软件、VAAPI 和 CUDA 编码适配，但源码路径可达不证明某台设备的 GPU 编码能力。

其他图形后端仍拒绝 application 模式；纯 Wayland、其他像素格式和各厂商桌面不能从 X11 结果外推。所需开发包与构建参数以 Sunshine 当前 CMake 及 Linux 工作流为准。

## 程序音频

`third_party/sunshine/src/platform/linux/application_audio.cpp` 实现 `platf::application_microphone`，与视频复用目标身份。PulseAudio 播放流必须属于目标进程，每流设置独立 monitor stream，再混合到原生 PCM 输出。

不移动应用播放流、不改默认设备、不回退整机音频。发现周期 250 ms，最多 64 路，PCM 队列预算 60 ms；消费停顿后丢弃旧积压。目标退出/退休后关闭监听，不能继续送旧音频。

使用 [PulseAudio 单流监听接口](https://freedesktop.org/software/pulseaudio/doxygen/stream_8h.html)，不增加新守护进程。PulseAudio 设备准备与 PipeWire-Pulse 模块兼容证据不自动证明所有 PipeWire 应用采集组合均已验收。

## 启动与窗口身份

Linux 保留原任务的 `/proc/<pid>/stat` 文件描述符验证存活与进程组，退出后不按数字 PID 重新打开恢复信任。入口要求独立进程组组长，拒绝服务端自身进程组。详情参照 [procfs](https://www.kernel.org/doc/html/v6.15/filesystems/proc.html)。

保留的存活成员持续证明进程组归属，启动器退出后已确认子进程可继续使用；成员离组、退出或目标退休后拒绝。每 250 ms 至多发现一次、最多保留 4096 任务。释放捕获身份不会结束应用。

初次绑定需要根进程仍存活；若已保留成员全部退出而只剩未发现后代，拒绝授权，不信任裸进程组数字。目标程序的启动器行为须实查。

X11 用 X-Resource 获取服务器报告的本地客户端 PID，再核对所属身份。窗口标题和应用自报 `_NET_WM_PID` 不作为归属证据；只选所属可见应用窗口，不选桌面根窗口。焦点及画面尺寸过期时拒绝输入，不用强抢焦点掩盖环境问题。

## 检查与证据

原生检查覆盖真实进程组、启动器退出、成员离组、同标题窗口、外部遮挡、尺寸变化、目标退休及输入焦点。日志管道启用失败传播，不能用 shell 管道尾命令成功掩盖编译/运行失败。

这些后端检查不同于安装后的浏览器媒体、GPU、物理麦克风或真实桌面环境验收。当前实际产品记录按其精确版本和环境保留；Windows 上的语法/交叉编译检查不能代替 Linux 原生运行。本轮不要求 Linux 真机验收，也不能因此将未测平台行为写成保证。
