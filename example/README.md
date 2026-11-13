# Stream Kit 综合开发示例

Example 是独立开发/演示应用，不属于客户生产安装包。Windows 原生棋盘窗口提供动态画面计数、分辨率/全屏、键盘/画布鼠标计数、程序音、录音和回放。关闭按钮及 Esc 可用，焦点在音频控件时 Esc 也应关闭整个窗口。

演示需要时单独构建并作为应用登记或上传；不要为部署 Example 重新打包生产安装器。

## 功能操作

| 操作 | 作用 |
| --- | --- |
| Record input | 显式选择输入端点后录音，查看实际电平 |
| Play test tone | 在指定输出播放 997 Hz 程序测试音 |
| Play recording | 录音结束后回放，不复制仍在采集的缓冲 |
| Stop recording / Stop playback | 各自停止输入或输出 |
| Stop all | 同时停止两方向及后续自动音频操作 |
| Analyze client tone | 分析已录 PCM 中的 1499 Hz 客户端测试音 |
| Analyze program tone | 检查目标录音中 997 Hz 程序音及回灌 |

输入和输出原生流独立，可在录音时发程序音；一个方向结束/错误不自动停止另一个方向。名称必须唯一匹配，缺失/歧义明确失败，不退回系统默认设备。新录音清除旧分析；未录音或仍在录音时拒绝分析，不自动打开设备。

真人讲话用电平与真实录音判断；频率分析是受控测试音工具，不识别任意讲话内容，也不自行判定端到端通过。测试声音不应在未经允许的演示中自动播放。

## 构建与启动参数

在原生 Windows Go/Rust/MSVC 环境执行 `example/build.ps1`，输出 `artifacts/example/checkerboard.exe`、`audio-probe.exe` 及 `example.zip`。两个程序保持同目录。正式独立组件构建入口为 `scripts/build-example-release.mjs`，不将该组件作为产品安装器输入。

| 参数 | 语义 |
| --- | --- |
| `-fullscreen` | 全屏窗口；仍保留 Esc 退出 |
| `--input-device=名称或稳定ID` | 预选输入，不自动开始录音 |
| `--tone-output=名称或稳定ID` | 显式输出设备 |
| `--tone-count=N` | 自动测试音次数 1–30000，每次 3 秒；任一音频手动操作取消后续循环 |
| `--input-events` | 仅本窗口输入/焦点事件的 JSON 观察，不记录键值、文字或全局输入 |

输入验收必须看目标实际计数变化，不以发送 API 成功或后台“控制者”标签替代。观察输出不能区分本地物理与远端注入，需要隔离其他输入。不能为获取焦点修改 ToDesk 或强行向未知窗口发送按键。

## 原生音频子进程

`audio-probe` 来自 `components/audio-target`，通过继承 stdin/stdout 按行 JSON 通信，无后台端口或独立服务；窗口关闭、父进程退出或管道断开时释放设备。程序音属于 Example 进程树，指定程序采集应包含该身份。

协议 v1：命令含 `schema_version/id/op`，响应带相同 id，主动事件 id=0；支持 `devices/status/capture/tone/playback/stop/stop_capture/stop_playback/analyze`。分析只处理已结束录音，不改变原 PCM、不打开新设备。完整协议及限制以音频组件源码为准，不能用于客户业务通信接口。

## 定向检查

- `example/smoke-test.ps1`：真实窗口、缩放、错误状态、退出及音频子进程回收。
- `go test ./...`（Example 目录）和音频组件 Cargo 检查：输入/输出状态与旧结果归属。
- `scripts/test-example-audio.cjs`：原生设备枚举、管道和无默认回退。
- `scripts/accept-example-input.ps1`：只对自建且确认前台窗口发送输入，观察模式不算输入验收。
- `scripts/accept-source-stream.cjs`：独立源组件与多个真实 Web 观看端，按选项检查媒体、控制权、停止和配置。
- `scripts/accept-example-audio.cjs`：明确指定专用端点的真实播放/录音/回放检查。

开发自动化参数以各脚本当前入口为准，不盲目拼接互斥选项。测试会创建自己的应用/进程/端口，结束应恢复归属空闲；不得启动或修改其他代理维护的 UE。既有 20 客户端四小时验收已接受，不因可配置更长保持时间就反复补跑 24 小时。

程序音广播、客户端麦克风发送、服务器端点实录和 UE 内部接收是不同证据；只开了浏览器麦克风或收到 RTP 不等于全部通过。版本边界统一见[发布基线](../docs/release-status.md)，不在本文堆历次执行流水。
