import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { setToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Card } from '@/components/ui/card'
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
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm p-8 shadow-lg rounded-xl">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-card-foreground">云端渲染平台</h1>
          <p className="text-sm text-muted-foreground mt-1">Cloud Rendering Platform</p>
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
            {loading ? '登录中...' : '登录'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
