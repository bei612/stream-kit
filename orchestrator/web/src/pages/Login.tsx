import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { setToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Radio, ArrowRight } from 'lucide-react'
import { Input, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) return

    setLoading(true)
    setError('')
    try {
      const data = await api.login(username, password)
      setToken(data.token)
      useWSStore.getState().connect()
      navigate('/', { replace: true })
    } catch (err: any) {
      setError(err.message)
    }
    setLoading(false)
  }

  return (
    <div className="login-shell">
      <section className="login-intro">
        <div className="flex items-center gap-3"><span className="brand-mark"><Radio size={22} /></span><span className="brand-name">STREAM KIT</span></div>
        <h1>云端渲染，<br />统一掌控。</h1>
        <p>从应用启动到客户端连接，在一个工作空间管理串流、控制权与音频。</p>
        <div className="login-facts"><span>应用与节点</span><span>共享串流</span><span>控制权与音频</span></div>
      </section>
      <section className="login-form-area" aria-label="管理员登录">
      <div className="login-form">
        <div className="mb-8">
          <p className="page-eyebrow">管理控制台</p>
          <h2>欢迎回来</h2>
          <p className="text-sm text-muted-foreground mt-2">使用管理员账号登录工作空间。</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="error">{error}</Alert>
          )}

          <div>
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </div>

          <Button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full"
          >
            {loading ? '登录中...' : '登录控制台'}<ArrowRight size={16} aria-hidden="true" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-6">观看客户端请使用管理员提供的观看链接。</p>
      </div>
      </section>
    </div>
  )
}
