# 网关浏览器构建依赖

网关 native 与 Web/WASM 绑定都来自 `third_party/moonlight-common-rust`。`ubrn.config.yaml` 使用生成器官方支持的本地目录模式，不执行远端 checkout。工具链使用官方 Rust 1.99.0（包含 wasm32-unknown-unknown）、Node.js 26.4.0/npm 11.17.0、wasm-bindgen-cli 0.2.128；Windows 使用 MSVC 和官方 Kitware CMake（本机验证 3.31.8）。不依赖旧网关发行二进制。

在相应工具链已进入 PATH 的终端执行：

```sh
cd third_party/moonlight-web-stream
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run build
npx --no-install playwright install --with-deps chromium
node ../../scripts/smoke-gateway-browser.cjs
```

Windows 应在 MSVC 开发终端执行；使用 NMake 时设置 `CMAKE_GENERATOR=NMake Makefiles`。可设置绝对路径 `CARGO_TARGET_DIR` 复用编译缓存，但不得让同一构建目录混用 CMake generator。`BROWSER_CHANNEL=chrome` 可选择本机 Chrome，否则使用 Playwright 安装的 Chromium。

`npm run build` 自动先导出 Rust API 类型，再执行 `scripts/build-gateway-bindings.mjs`，最后由 Webpack 输出 `dist`。Rust release 服务运行时从 `static` 读取页面，打包时必须把该 `dist` 内容放入运行目录的 `static`。原生服务端构建入口仍为 `cargo build --locked --release`；当前脚本不代表完整产品安装包已经完成。

- `uniffi-generator.Cargo.lock` 锁定 npm 包内官方 Rust 生成器的依赖。
- `wasm.Cargo.lock` 锁定生成的 WASM shim、UniFFI runtime 和应用绑定的依赖。
- 原生绑定与网关自己的 `Cargo.lock` 分别保留在对应源码工作区。
- 构建先恢复生成器/shim 锁，显式 `cargo fetch --locked`；生成器通过 `cargo run --locked` 调用。WASM 编译使用 `--locked --release`。官方生成器内部的 native build 未提供 locked 参数，因此先验证锁、离线生成，并检查生成前后 native 锁字节不变，变化即失败。不会自动更新仓库锁或修改安装的生成器源码。

更新依赖时需在独立工作区重新解析并审阅这些锁，验证完整 native/Web 构建和浏览器 ABI 后一起提交，不以删除锁作为常规构建步骤。这些锁提供依赖解析一致性；尚不能据此声称全平台字节级可复现或完整离线供应链已验收。

浏览器 smoke 使用真正的生产网页及 release WASM，验证路径前缀、离线提示、仅公共离线页缓存、初始化及键盘/ICE ABI；认证响应是显式 fixture。结果及各产物 SHA-256 写入 `artifacts/gateway-browser/result.json`。它不建立 Sunshine 上游，也不证明 UE5 收到麦克风、真实观看/输入、移动端兼容或负载验收通过。
