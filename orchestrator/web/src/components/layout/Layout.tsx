import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { LayoutDashboard, Box, AppWindow, Upload, ScrollText, Settings, Radio, ChevronRight, Menu, X, BookOpen, LogOut } from 'lucide-react'
import { useWSStore } from '@/stores/websocket'
import { LanguageSwitcher, useManagementLocale } from '@/i18n'
import { clearToken } from '@/lib/utils'

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const connected = useWSStore(state => state.connected)
  const { t } = useManagementLocale()
  const navigate = useNavigate()
  const navItems = [
    { path: '/', label: t('nav.dashboard'), icon: LayoutDashboard },
    { path: '/components', label: t('nav.components'), icon: Box },
    { path: '/apps', label: t('nav.apps'), icon: AppWindow },
    { path: '/upload', label: t('nav.upload'), icon: Upload },
    { path: '/stream-sessions', label: t('nav.sessions'), icon: Radio },
    { path: '/logs', label: t('nav.logs'), icon: ScrollText },
    { path: '/settings', label: t('nav.settings'), icon: Settings },
  ]
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const accountMenu = useRef<HTMLDivElement>(null)
  const accountButton = useRef<HTMLButtonElement>(null)
  const handleLogout = () => {
    useWSStore.getState().disconnect()
    clearToken()
    setAccountOpen(false)
    navigate('/login', { replace: true })
  }
  useEffect(() => {
    if (!accountOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!accountMenu.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountOpen(false)
        accountButton.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [accountOpen])
  const activeItem = navItems.find(item => item.path !== '/' && location.pathname.startsWith(item.path)) ?? (location.pathname === '/docs' ? { path: '/docs', label: t('nav.guide'), icon: BookOpen } : navItems[0])

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">{t('common.skipToContent')}</a>
      <nav className="app-navigation" aria-label={t('common.mainNavigation')} data-expanded={navigationOpen} onKeyDown={event => {
        if (event.key === 'Escape' && navigationOpen) { setNavigationOpen(false); menuButton.current?.focus() }
      }}>
        <div className="navigation-heading">
          <Link to="/" className="app-brand">
            <span className="brand-mark"><Radio size={22} aria-hidden="true" /></span>
            <span><span className="brand-name">{t('brand.name')}</span><span className="brand-caption block">{t('brand.serverConsole')}</span></span>
          </Link>
          <button ref={menuButton} type="button" className="navigation-toggle" aria-label={navigationOpen ? t('nav.collapse') : t('nav.expand')} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(value => !value)}>
            {navigationOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        <p className="nav-caption">{t('nav.workspace')}</p>
        <div id="workspace-navigation" className="nav-links">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)
            return (
              <Link
                key={path}
                to={path}
                className="nav-link"
                aria-current={active ? 'page' : undefined}
                onClick={() => setNavigationOpen(false)}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            )
          })}
        </div>

        <div className="nav-footer">
          <Link to="/docs#overview" className="nav-help-link" onClick={() => setNavigationOpen(false)}><BookOpen className="w-4 h-4" /> {t('nav.guide')}</Link>
          <p>{t('nav.footer')}</p>
        </div>
      </nav>

      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-container workspace-bar-content">
          <div className="workspace-path"><span>{t('brand.serverConsole')}</span><ChevronRight size={13} aria-hidden="true" /><span className="text-card-foreground">{activeItem.label}</span></div>
          <div className="workspace-identity"><span className="connection-indicator" data-connected={connected}>{connected ? t('common.connected') : t('common.reconnecting')}</span><LanguageSwitcher /><div className="account-menu" ref={accountMenu}>
            <button ref={accountButton} type="button" className="admin-avatar account-trigger" title={t('nav.account')} aria-label={t('nav.account')} aria-expanded={accountOpen} aria-haspopup="menu" onClick={() => setAccountOpen(value => !value)}>A</button>
            {accountOpen && <div className="account-popover" role="menu">
              <div className="account-popover-heading"><span className="account-popover-label">{t('nav.admin')}</span><span className="account-popover-caption">{t('brand.serverConsole')}</span></div>
              <button type="button" className="account-menu-item" role="menuitem" onClick={handleLogout}><LogOut className="w-4 h-4" />{t('nav.logout')}</button>
            </div>}
          </div></div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="workspace-container workspace-main">{children}</main>
      </div>
    </div>
  )
}
