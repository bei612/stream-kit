# Stream Kit 开发与构建

本文用于长期维护、构建和检查。客户机安装不需要下列开发工具。产品功能见[需求](项目需求.md)，精确发布及验收状态见[基线](release-status.md)。

## 源码与依赖

生产源码为 `orchestrator/`、`third_party/sunshine/`、`third_party/moonlight-web-stream/`、`third_party/moonlight-android/` 及其纳管依赖。不要从 `docs/src/` 构建或用下载的原版二进制替换二开运行时。Moonlight Qt 是纳管参考组件，不是当前统一客户端发布入口。

全部上游按普通文件纳管，不执行 `git submodule update`。来源清单记录导入时的上游版本、提交和归档摘要，不表示二开后文件仍与原归档逐字节相同，也不是部署状态索引。

| 技术 | 当前构建依据 |
| --- | --- |
| Go | `orchestrator/go.mod` + vendor；CI 使用 1.27.3 |
| 管理 Web | Node 26.4.0，`orchestrator/web/package-lock.json`；React 19、Vite 8、TypeScript、Tailwind、TanStack Query、Zustand |
| Rust 网关 | `third_party/moonlight-web-stream/rust-toolchain.toml`，1.99.0，Cargo.lock、WASM target 与配套绑定生成器 |
| Sunshine Windows | 原生 MSYS2 UCRT64、官方 CMake 3.31.8；不要混入 MSVC 的 LIB/INCLUDE 搜索环境 |
| 安装器 | 官方 Inno Setup 7.1.1；打包驱动使用官方 Windows SDK signtool |
| Android | 项目 Gradle Wrapper、Java 21、SDK platform/build-tools 37、NDK 29.0.14206865；精确设置见 Gradle/工作流 |

版本以源码锁文件和当前 CI 为准，不在本机随意换“兼容版本”。Windows 开发使用原生 Windows，不迁移到 WSL；Linux 构建/运行由独立 Linux 环境和 CI 完成。开发者工具不进入产品安装包。

## 管理端开发

```sh
cd orchestrator/web
npm ci
npm run dev
```

Vite 开发地址默认 5173，`/api` 代理到独立开发控制服务 `http://localhost:9000`。它不是生产 HTTPS 入口；不要为开发代理修改运行中的客户部署。若开发后端地址不同，在开发配置中显式维护，不写死现场 IP。

```sh
npm run lint
npm run build
```

后端在 `orchestrator/` 中运行测试与 vet：

```sh
go test ./...
go vet ./...
```

必要 Windows 私有管道/进程测试须在 Windows；Linux 权限及音频服务测试须在 Linux。交叉编译只能证明编译边界。

## 完整组件构建

以下命令在仓库根目录执行。从干净且已冻结来源的工作树构建，使用新输出目录：

```text
node scripts/build-control-plane.mjs --require-clean --output NEW_CONTROL_DIRECTORY
node scripts/build-gateway-release.mjs --output NEW_GATEWAY_DIRECTORY
node scripts/verify-sunshine-release.mjs SUNSHINE_BUILD_DIRECTORY FULL_COMMIT --output NEW_RENDERER_DIRECTORY
node scripts/package-platform-release.mjs CONTROL_BUNDLE GATEWAY_BUNDLE RENDERER_BUNDLE NEW_PLATFORM_DIRECTORY
```

Sunshine 源码构建入口 `scripts/build-sunshine.sh`，Windows 在 UCRT64 环境执行；Linux 统一布局设 `SUNSHINE_PACKAGE_LAYOUT=platform`。不要用运行时测试目录代替正式 renderer staging。组件打包说明见 [CONTROL](../deploy/CONTROL-BUNDLE.md)、[GATEWAY](../deploy/GATEWAY-BUNDLE.md)、[RENDERER](../deploy/RENDERER-BUNDLE.md)。

Windows 静态 Qt 的链接依赖须显式安装，包括 UCRT64 的 `libb2`、`libtiff`、`harfbuzz` 和 `freetype`；仅安装 `qt6-static` 不保证其全部静态依赖已就绪。统一构建工作流在编译编解码库前执行 `pkg-config --static` 检查，包版本随构建日志保存。继续使用已固定的官方 CMake，不通过关闭托盘或删 Qt 依赖绕过缺包。

统一包的布局以 `orchestrator/internal/bundle/layouts.json` 为唯一来源，原生 `verify-platform` 与打包器共同使用。源码身份、平台/架构、必需静态资源和全部库存摘要一致才能组装。文件清单不是发行者签名或完整许可审查。

## 原生安装器与 APK

Windows 使用[安装器构建说明](../deploy/windows/README.md#构建与精确发布)，Linux 入口为 `scripts/build-linux-installer.mjs`，参数以当前脚本为准。每平台一个安装器，不捆绑开发套件或测试负载。

Android 调试及 release HTTP 边界测试：

```text
cd third_party/moonlight-android
./gradlew :app:testNonRootReleaseUnitTest :app:assembleNonRootDebug
```

在 Windows 从 Android 目录使用 `gradlew.bat`。正式签名与发布使用 `.github/workflows/android-release.yml` 及 `scripts/android/`；项目持久签名密钥单独保管，不自动新建替换、不得入库或输出。debug APK 不当作正式客户端。

本机调试使用官方 Android SDK/Emulator，复用已有 AVD；实体平板通过正常 USB 授权接入，离线不代表可发送操作。不改 ToDesk，不安装第三方游戏模拟器，不为验证擅自重启宿主机。

## 检查按影响执行

| 变更 | 最小相关检查 |
| --- | --- |
| Go API、数据、生命周期 | 对应及关联消费者测试、vet、目标平台编译 |
| 管理 Web | 全量 TypeScript、lint、生产构建；真实部署 playwright-cli 操作及截图 |
| 网关/媒体 | 锁定 Cargo 检查与生产 Web/WASM；真实协议、解码及释放路径 |
| 程序采集/声音 | 独立 Example 的真实窗口、程序音与目标录音，不启动其他项目 UE |
| Android | release/debug 构建边界、正式 APK 的相关原生媒体/输入/生命周期 |
| 安装器 | 精确产物静默安装、服务/组件、退出码、重启关系及卸载；不是仅检查脚本内容 |
| 地址/TLS | 同一 CA 下严格 TLS、公开地址、真实数据面；整机重启单独记录 |
| 文档 | 相对链接、源码路径、命令、版本一致性、敏感信息及历史/当前措辞 |

不把 fixture、替代请求、MockWebServer 或历史 VM 检查当成部署验收；已有测试目录中的隔离工具不进入生产。保留失败及版本边界，不通过降低阈值或隐藏错误达成通过。已经通过且变更未影响的长测不重复执行。

运行资源变更的定向回归见[资源所有权](runtime-resources.md)。网关原生测试使用 `cargo test --locked --release --bin web-server`，WebRTC 库使用 `cargo test --locked --release --lib`；实际浏览器解码运行 `node scripts/accept-browser-decoder.cjs`。后者是原生编解码及缓冲验证，不替代已安装播放器的 playwright-cli 验收。正式网关构建复用 release profile 导出绑定，避免额外生成整套 debug 原生依赖。

## 发布与来源

现有 Actions 包括跨平台源码、统一产品、Windows 精确安装、管理页 CLI、Android 构建/发布和定向媒体/网络任务。统一产品工作流支持发布已成功原始产物，不因测试或文档变化重新构建运行时。准确参数参见[Windows CI 发布](../deploy/windows/CI-RELEASE.md)。

发布时核对标签、源码、安装器/API验收身份、附件大小和 SHA-256，并提供依赖来源及许可证。上游保留的静态库不是本项目重编译证明；签名上游驱动不是本项目自签内核模块。未解决的许可/来源边界必须如实保留。

## 长期维护边界

每次修改先核对全链路和数据所有者，再完成实现、review、相关检查及正式文档。前端资源与接口共同回退，不把新页面配旧后端。参数集中配置，不将现场 IP、应用 ID、账号或观看密钥写入产品。

`.local/`、`artifacts/`、浏览器截图及临时运行数据不是文档入口或生产源。临时大构建输出按明确归属清理，不能递归删除未知路径或历史用户数据。历史失败材料在 `docs/evidence/` 保留，长期文档不继续堆积流水记录。
