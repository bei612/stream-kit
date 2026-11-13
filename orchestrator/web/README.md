# Stream Kit 管理前端

这是统一管理页与永久观看入口，非 Vite 示例项目。使用 React、TypeScript、React Router、Tailwind、TanStack Query 与 Zustand；精确依赖以 package-lock.json 为准。

## 开发与构建

```sh
npm ci
npm run dev
npm run lint
npm run build
```

开发监听 5173，`vite.config.ts` 将 `/api` 代理至独立开发控制端 `http://localhost:9000`。生产由 Go 服务提供 `dist/`，不运行 Vite，也不需要客户机安装 Node.js。

源码、dist、API 和控制组件清单应同源发布；只换 EXE 或只换页面都可能破坏契约。完整构建见[开发指南](../../docs/development.md)。

## 页面与状态所有者

| 位置 | 职责 |
| --- | --- |
| `src/pages/` | 仪表盘、组件、应用/详情/上传、会话、设置、日志、登录和公开 Watch |
| `src/api/` | 类型化 API、响应外层、统一错误和查询资源键 |
| `src/hooks/useQuery.ts` | 原查询库的订阅、轮询、取消和显式刷新 |
| `src/hooks/useConfigurationDraft.ts` | 服务器原值、编辑草稿、保存及版本冲突 |
| `src/hooks/useAppCommand.ts` | 应用命令的请求与反馈归属 |
| `src/lib/session-overview.ts` | 单一 overview、身份/版本/时效判断 |
| `src/components/AppWatchLink.tsx` | 永久链接读取、变更及不确定结果隔离 |
| `src/pages/Watch.tsx` | 当前准入尝试和 iframe 生命周期 |
| `src/stores/websocket.ts` | 管理事件连接及失效通知 |

API 结果不持久化为另一份权限来源。资源键包含应用 ID、分页和筛选；记录、total、加载与错误按同一响应管理。登出或过期清缓存，旧请求不能覆盖新的应用或观看尝试。会话页使用同一服务器 overview，不拼接两个独立轮询状态。

完整原则见[前端状态管理](../../docs/managed-session-state.md)，产品操作见[使用手册](../../docs/user-guide.md)。

所有后台路由使用 `components/layout/Page.tsx` 的 Page/ContentGrid，与 Layout 共用唯一容器和间距。页面不再自行限制最大宽度；设置分区跳转保持编辑器挂载，导航与按钮分别使用 LinkButton/Button。布局规则和多尺寸检查见[管理端布局维护](../../docs/management-layout.md)。

## 变更检查

类型/lint/生产构建后，用 playwright-cli 对实际部署操作并截图，核对加载/空态/错误、分页、停止后参数保存、控制交接、终态和移动布局。不要用 mock 预览替代部署检查，也不要向生产加入测试探针或现场凭据。
