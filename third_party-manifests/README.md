# 纳管源码与原生构建

`pulseaudio-rs.json` 记录 Linux 音频协议依赖 `pulseaudio 0.3.2` 的 crates.io 归档 SHA-256 和上游提交，MIT 许可证保留在 `third_party/pulseaudio-rs/LICENSE.md`。独立音频组件和媒体网关的 Cargo 根清单均将该依赖指向同一份仓库源码；两个生产锁文件与依赖自身的回归测试锁文件分别纳管。二开限制每轮接收批次并保留未读状态，使连续录音时仍能调度时延、暂停和删除命令；不通过遗留后台线程或强杀设备进程宣称释放成功。持续可读与分片回归测试、Linux 独立设备对检查由 `linux-native-capture` 执行，实际通过状态以对应提交的运行结果为准。

`webrtc-rs.json` 记录 WebRTC 异步层 0.21.1 的 crates.io 归档来源与摘要，源码位于 `third_party/webrtc-rs`，由网关通过 Cargo 路径依赖编译。保留 MIT/Apache-2.0 许可证；移除归档中的未使用 submodule 声明，rtc 仍使用 Cargo 锁定依赖。二开把 UDP 范围选端口放到实际套接字绑定层，避免并发连接在探测后释放端口产生竞争；ICE 重绑复用同一策略。生产依赖锁定见网关 Cargo.lock，源码单元测试依赖单独锁定在该目录 Cargo.lock。

`upstream-lock.json` 锁定主组件，`sunshine-dependencies.json` 锁定 Sunshine 原有嵌套依赖及 NVENC 头文件。依赖是本仓库普通文件，不需要 `git submodule update`。清单保留上游仓库、提交、下载归档摘要以及可执行文件/符号链接模式。AMF 仅纳入构建使用的公开头文件、README 和许可证，不纳入无关示例二进制、PDB 与预编译 FFmpeg。

源码二开与上游快照统一提交。源归档摘要表示导入来源，不表示二开后文件仍与原归档逐字节相同。当前构建调整包括：显式使用本地源码编译的 FFmpeg；NVENC 头文件使用本仓库源码；x265 使用准确的 4.1 归档版本；SVT-AV1 使用源码声明的版本；补丁必须实际应用或已完整应用，不能静默跳过。

Windows 开发使用官方 MSYS2 的 UCRT64 原生工具链，不使用 WSL。当前安装基线为官方 `2026-09-27` 发行包，`msys2-base-x86_64-20260927.tar.xz` 的 SHA-256 为 `ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322`。依赖通过启用签名验证的 pacman 安装。可按 [MSYS2 官方镜像说明](https://www.msys2.org/dev/mirrors/) 调整镜像优先级；镜像切换不改变包来源、签名要求和版本。

在 UCRT64 环境准备 Sunshine 与 build-deps 上游声明的编译依赖，并把原生 Windows Node.js 放入 PATH。执行：

```powershell
C:\msys64\msys2_shell.cmd -defterm -here -no-start -ucrt64 -c 'bash scripts/build-sunshine.sh'
```

Linux 安装对应的上游构建依赖后使用同一脚本：

```sh
bash scripts/build-sunshine.sh
```

脚本将依赖和 Sunshine 输出放入 `.local/cmake-build-sunshine-deps` 与 `.local/cmake-build-sunshine`，默认两个编译任务，可用 `BUILD_JOBS` 调整。统一产品构建设置 `SUNSHINE_BUILD_WINDOWS_INSTALLERS=OFF`，保留组件安装文件、运行工具、Web、托盘和测试，使用 ZIP 组件包供统一产品组装；需要独立 Sunshine NSIS/MSI 安装器时显式设为 `ON` 并准备上游要求的 WiX/.NET 工具链。它不部署服务、不安装驱动、不执行可能操作设备的集成测试。完整原生测试与运行验收应使用对应构建产物另行执行；Linux 命令存在不代表本轮已完成 Linux 真机验收。

`node tools/check-sunshine-vendor.cjs` 检查依赖纳管、关键构建输入、Git 文件模式与 submodule 禁令。`cmake -P tools/test-source-patching.cmake` 验证补丁的实际应用、幂等性、不匹配及部分应用拒绝。构建脚本另行链接并运行 `tools/sunshine-codec-probe.c`，检查编码器注册，不打开 GPU/音频设备，不以该检查代替实际编码验收。工具链版本、构建日志、产物摘要保存在实际构建验收记录中；完成依赖纳管不等于完成 Sunshine 编译、程序级采集或生产验收。
