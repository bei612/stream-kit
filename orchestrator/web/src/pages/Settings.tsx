import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { clearToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LogOut } from 'lucide-react'
import { AudioDevices } from '@/components/AudioDevices'

export default function Settings() {
  const [config, setConfig] = useState<any>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.getConfig().then(r => setConfig(r.data)).catch(() => {})
  }, [])

  const handleLogout = () => {
    useWSStore.getState().disconnect()
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="page-heading"><div><p className="page-eyebrow">工作空间配置</p><h2>系统设置</h2><p className="page-description">查看服务配置，管理当前管理员登录。</p></div></div>

      {/* Logout */}
      <Card>
        <CardHeader>
          <CardTitle>账户</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={handleLogout}
            className="border-red-400/30 text-red-300 hover:bg-red-900/20"
          >
            <LogOut className="w-4 h-4" /> 退出登录
          </Button>
        </CardContent>
      </Card>

      <AudioDevices />

      {/* Current config display */}
      {config && (
        <Card>
          <CardHeader>
            <CardTitle>当前配置（脱敏）</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 font-mono text-card-foreground">
              {JSON.stringify(config, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
