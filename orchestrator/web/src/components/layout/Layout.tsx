import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { LayoutDashboard, Box, AppWindow, Upload, ScrollText, Settings, Radio, ChevronRight } from 'lucide-react'
import { useWSStore } from '@/stores/websocket'

const navItems = [
  { path: '/', label: '工作台', icon: LayoutDashboard },
  { path: '/components', label: '组件管理', icon: Box },
  { path: '/apps', label: '应用管理', icon: AppWindow },
  { path: '/upload', label: '上传应用', icon: Upload },
  { path: '/stream-sessions', label: '渲染会话', icon: Radio },
  { path: '/logs', label: '操作日志', icon: ScrollText },
  { path: '/settings', label: '系统设置', icon: Settings },
]

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const connected = useWSStore(state => state.connected)
  const activeItem = navItems.find(item => item.path !== '/' && location.pathname.startsWith(item.path)) ?? navItems[0]

  return (
    <div className="app-shell">
      <nav className="app-navigation" aria-label="主导航">
        <div>
          <Link to="/" className="app-brand">
            <span className="brand-mark"><Radio size={22} aria-hidden="true" /></span>
            <span><span className="brand-name">STREAM KIT</span><span className="brand-caption block">云渲染 · 统一控制台</span></span>
          </Link>
        </div>
        <p className="nav-caption">工作空间</p>
        <div className="nav-links">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)
            return (
              <Link
                key={path}
                to={path}
                className="nav-link"
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            )
          })}
        </div>

        <div className="nav-footer">一个控制台，连接所有画面。</div>
      </nav>

      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-path"><span>控制台</span><ChevronRight size={13} aria-hidden="true" /><span className="text-card-foreground">{activeItem.label}</span></div>
          <div className="workspace-identity"><span className="connection-indicator" data-connected={connected}>{connected ? '实时连接' : '连接恢复中'}</span><span className="admin-avatar" title="管理员">管</span></div>
        </header>
        <main id="main-content" className="workspace-main">{children}</main>
      </div>
    </div>
  )
}
