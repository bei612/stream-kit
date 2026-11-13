# Stream Kit 长期文档

本文是项目长期文档的导航入口。使用说明以当前受支持的代码行为为准；版本及现场状态只在[发布与部署基线](release-status.md)集中维护。

## 使用与运维

| 文档 | 解决的问题 |
| --- | --- |
| [项目需求](项目需求.md) | 平台做什么、核心要求和明确限制 |
| [交付目标与完成条件](goal-current.md) | 范围、完成定义及验收约束，不承载执行流水 |
| [使用手册](user-guide.md) | 应用、固定链接、连接、控制权、声音及参数操作 |
| [部署运维](../deploy/README.md) | 服务关系、自启动、检查、备份、更新与排障 |
| [Windows 安装](../deploy/windows/README.md) | 单 EXE、静默参数、UAC、桌面身份、退出码 |
| [Linux 安装](../deploy/linux/INSTALL.md) | Ubuntu 单文件安装、用户服务及音频会话 |
| [地址与证书](lan-address-configuration.md) | HTTP/HTTPS、本机/LAN、IP 变化与信任保持 |
| [Android 操作](android-viewer-controls.md) | 安装导入、工具栏、权限、设置和生命周期 |
| [发布与部署基线](release-status.md) | 可下载版本、本机组件、证据和待验证项 |

## 开发与契约

| 文档 | 内容 |
| --- | --- |
| [技术架构](技术架构细节.md) | 模块边界、数据所有权、媒体/控制链路及安全 |
| [运行资源与释放](runtime-resources.md) | 长跑资源预算、背压、连接释放、缓存及日志保留 |
| [开发指南](development.md) | 原生工具链、锁文件、构建、检查及源码导航 |
| [前端状态管理](managed-session-state.md) | 权威快照、查询缓存、编辑草稿和异步结果归属 |
| [管理端布局](management-layout.md) | 统一页面、容器响应式、表格边界及跨页复用 |
| [固定观看链接](../contracts/application-watch-links.md) | 永久能力凭据、撤销、准入和自动配对 |
| [客户端连接](../contracts/client-connections/README.md) | 租约、恢复、终态与凭据隔离 |
| [媒体状态](../contracts/media-state/README.md) | 签名快照、版本确认及观测 |
| [管理事件](../contracts/management-events/README.md) | 实时事件、失效通知和客户端刷新 |
| [公开地址](../contracts/public-addresses.md) | 浏览器地址派生、CORS、原生 HTTPS 和发现 |
| [网关配置](../contracts/gateway-configuration.md) / [编码配置](../contracts/encoder-configuration.md) | 配置版本、保存、应用和运行确认 |
| [音频设备](../contracts/audio-devices/README.md) | 端点身份、目标路由及权限 |
| [Android 接入](../contracts/android-client.md) | 原生会话、输入、媒体与生命周期适配 |
| [纳管源码](../third_party-manifests/README.md) | 上游来源、二开与依赖边界 |
| [独立 Example](../example/README.md) | 开发用画面、输入及声音验证工具 |

## 文档分工与维护

- README 用于首次了解与导航；需求描述产品行为；架构解释实现；手册提供可操作步骤。接口字段的精确定义归 `contracts/` 和对应源码，避免复制多份过时字段表。
- 当前发布和现场版本集中在 `release-status.md`，记录日期并区分源码、发布包、已安装组件。安装默认值与现场覆盖值分别表述。
- `deploy/releases/` 是不可当作当前操作指南的历史发布说明；`docs/evidence/` 保留有版本和环境边界的验收材料。历史失败不删除，不因后续通过改写。
- 根目录早期深读资料及 `docs/src/` 仅用于历史原理参考，不能作为生产构建、服务部署或权限协议的依据。
- 长期文档不追加逐次构建流水、临时任务清单或调试输出。不收录密码、观看密钥、JWT、私钥和完整受保护配置。
- 功能变更须同步更新相应手册及契约；发布只更新版本基线及对应发布说明；文档修改本身不代表运行时已经升级或新增验收通过。
