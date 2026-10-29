import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { cn } from '@/lib/utils'
import { LayoutDashboard, Box, AppWindow, Upload, ScrollText, Settings, Zap, Radio } from 'lucide-react'

const navItems = [
  { path: '/', label: '仪表盘', icon: LayoutDashboard },
  { path: '/components', label: '组件管理', icon: Box },
  { path: '/apps', label: '应用管理', icon: AppWindow },
  { path: '/upload', label: '上传应用', icon: Upload },
  { path: '/stream-sessions', label: '渲染会话', icon: Radio },
  { path: '/logs', label: '操作日志', icon: ScrollText },
  { path: '/settings', label: '系统设置', icon: Settings },
]

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()

  return (
    <div className="flex h-screen">
      <nav className="w-56 flex-shrink-0 bg-card border-r border-border flex flex-col" aria-label="主导航">
        <div className="px-4 py-5 border-b border-border">
          <Link to="/" className="flex items-center gap-2 text-foreground font-bold text-lg">
            <Zap className="w-5 h-5 text-primary" />
            云端渲染平台
          </Link>
          <div className="text-[10px] text-muted-foreground mt-0.5 tracking-wider uppercase">Orchestrator</div>
        </div>

        <div className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            )
          })}
        </div>

        <div className="px-4 py-3 border-t border-border text-[10px] text-muted-foreground">
          Cloud Rendering Platform
        </div>
      </nav>

      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  )
}
