import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import Layout from '@/components/layout/Layout'
import Dashboard from '@/pages/Dashboard'
import Components from '@/pages/Components'
import Apps from '@/pages/Apps'
import AppDetail from '@/pages/AppDetail'
import Upload from '@/pages/Upload'
import Logs from '@/pages/Logs'
import Settings from '@/pages/Settings'
import StreamSessions from '@/pages/StreamSessions'
import Login from '@/pages/Login'
import { useWSStore } from '@/stores/websocket'
import { useEffect } from 'react'
import { isLoggedIn, getToken, clearToken } from '@/lib/utils'

function NotFound() {
  return (
    <div className="text-center py-16">
      <h2 className="text-4xl font-bold mb-4">404</h2>
      <p className="text-muted-foreground mb-4">页面不存在</p>
      <Link to="/" className="text-blue-500 hover:underline">返回仪表盘</Link>
    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center">
          <h2 className="text-2xl font-bold text-red-300 mb-4">页面出错了</h2>
          <p className="text-muted-foreground mb-4">{this.state.error?.message}</p>
          <button
            onClick={() => { this.setState({ hasError: false }); window.location.href = '/' }}
            className="px-4 py-2 rounded bg-primary text-primary-foreground"
          >
            返回首页
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function TokenExpiryChecker() {
  useEffect(() => {
    const check = () => {
      const token = getToken()
      if (!token) return
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          clearToken()
          window.dispatchEvent(new CustomEvent('auth-error'))
        }
      } catch { /* malformed token, ignore */ }
    }
    check() // check immediately on mount
    const timer = setInterval(check, 60000)
    return () => clearInterval(timer)
  }, [])
  return null
}

function WSConnector() {
  const connect = useWSStore(s => s.connect)
  useEffect(() => {
    if (isLoggedIn()) connect()
    return () => useWSStore.getState().disconnect()
  }, [connect])
  return null
}

function AuthRedirector() {
  useEffect(() => {
    const handler = () => {
      useWSStore.getState().disconnect()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    window.addEventListener('auth-error', handler)
    return () => window.removeEventListener('auth-error', handler)
  }, [])
  return null
}

// Route guard: redirect to /login if not authenticated
function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!isLoggedIn()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <WSConnector />
      <TokenExpiryChecker />
      <AuthRedirector />
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/components" element={<Components />} />
                  <Route path="/apps" element={<Apps />} />
                  <Route path="/apps/:id" element={<AppDetail />} />
                  <Route path="/upload" element={<Upload />} />
                  <Route path="/logs" element={<Logs />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/stream-sessions" element={<StreamSessions />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Layout>
            </RequireAuth>
          } />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
