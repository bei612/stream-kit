# Android 系统音频焦点验收工具

这是独立 `testOnly` 包 `io.github.bei612.streamkit.focusobserver`，只在受管测试模拟器使用，不进入正式 APK、服务端安装包或客户部署。它不包含网络、麦克风、PCM 生成或产品内部接口，也不复用既有输入测试包的签名身份。

辅助服务使用公开 `AudioFocusRequest` 申请 `AUDIOFOCUS_GAIN_TRANSIENT`。Android 15+ 要求申请者位于前台或运行前台服务，因此使用声明了 `mediaPlayback` 类型的普通前台服务及通知。服务入口要求调用方持有系统 `DUMP` 权限，供 ADB shell 启动；不会替换自身 UID 或绕过音频策略。60 秒自动停止仅用于清理保护，不作为通过条件。

在已有 Android SDK、JDK 的隔离 GitHub runner 中复用现有构建入口：

```bash
bash tools/input-acceptance/android/build.sh focus
```

输出为 `artifacts/input-example/android-focus/observer.apk`，使用独立、临时测试签名。默认不带参数的 `input` 构建保持原输入观察包与输出目录。Windows 本机验收使用官方 JDK 21 和已安装 SDK 37.0 工具执行相同的 javac、D8、aapt2、zipalign、apksigner 步骤；实际 APK、源文件哈希和构建环境分别记录，不声明两个环境生成相同签名产物。

先确认目标为自己启动的测试模拟器、正式客户端已连接 Example 且获得控制权，再由客户端主动开启麦克风。对该测试设备执行：

```bash
adb -s "$SERIAL" install -t artifacts/input-example/android-focus/observer.apk
adb -s "$SERIAL" shell am start-foreground-service --user current -n io.github.bei612.streamkit.focusobserver/.FocusService
adb -s "$SERIAL" shell dumpsys activity service io.github.bei612.streamkit.focusobserver/.FocusService
adb -s "$SERIAL" shell dumpsys audio
adb -s "$SERIAL" shell am stop-service --user current -n io.github.bei612.streamkit.focusobserver/.FocusService
```

`STREAM_KIT_FOCUS_OBSERVER result=1` 表示真实系统请求已授予；还必须核对系统焦点栈中客户端收到 `LOSS_TRANSIENT`，后台对应连接的麦克风停止、连接和控制代次保持不变，且客户端 Activity 仍在前台。停止辅助服务后，客户端焦点应恢复为 `GAIN` / `none`，麦克风保持关闭，只有再次主动点击才恢复录音。

Android 16 的 `am stop-service` 在输出 `Service stopped` 时也可能返回 255。必须同时验证精确返回文本和实际焦点栈中辅助服务已退出，不能直接忽略非零返回码或仅凭文本宣称成功。完成后卸载该独立测试包，保留原输入测试包和正式客户端。

验收边界：焦点、前台状态及麦克风生命周期检查不代表声音质量、真实扬声器/耳机、真人语音、系统电话来电或所有焦点类型均已通过。

来源：[Android 音频焦点规则](https://developer.android.com/media/optimize/audio-focus)、[前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[Android 16 服务命令实现](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android16-release/services/core/java/com/android/server/am/ActivityManagerShellCommand.java)。
