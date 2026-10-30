import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { clearToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LogOut } from 'lucide-react'
import { AudioDevices } from '@/components/AudioDevices'
import { Alert } from '@/components/ui/alert'
import { ConfigurationEditor } from '@/components/ConfigurationEditor'

export default function Settings() {
  const [config, setConfig] = useState<any>(null)
  const [configError, setConfigError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    api.getConfig().then(r => setConfig(r.data)).catch((error:unknown) => setConfigError(error instanceof Error?error.message:'无法读取服务配置'))
  }, [])

  const handleLogout = () => {
    useWSStore.getState().disconnect()
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="page-heading"><div><p className="page-eyebrow">工作空间配置</p><h2>系统设置</h2><p className="page-description">管理服务参数、查看生效状态与音频设备。</p></div></div>

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

      <ConfigurationEditor />
      <AudioDevices />

      {/* Current config display */}
      {configError && <Alert variant="error" role="alert">配置读取失败：{configError}</Alert>}
      {config && (
        <Card>
          <CardHeader>
            <CardTitle>当前配置（脱敏）</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">密码、环境变量值、启动命令和 webhook 地址已隐藏。此处为当前运行配置，仅供查看。</p>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 font-mono text-card-foreground">
              {JSON.stringify(config, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
