import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { useQuery } from '@/hooks/useQuery'
import { clearToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ContentGrid, Page } from '@/components/layout/Page'
import QueryWrapper from '@/components/QueryWrapper'
import { LogOut } from 'lucide-react'
import { AudioDevices } from '@/components/AudioDevices'
import { ConfigurationEditor } from '@/components/ConfigurationEditor'
import { GatewayConfigurationEditor } from '@/components/GatewayConfigurationEditor'
import { EncoderConfigurationEditor } from '@/components/EncoderConfigurationEditor'
import { RenderNodes } from '@/components/RenderNodes'

const sections = [
  { id: 'service-settings', label: '管理服务', editor: <ConfigurationEditor /> },
  { id: 'render-nodes', label: '渲染节点', editor: <RenderNodes /> },
  { id: 'gateway-settings', label: '媒体网关', editor: <GatewayConfigurationEditor /> },
  { id: 'encoder-settings', label: '渲染编码器', editor: <EncoderConfigurationEditor /> },
  { id: 'audio-devices', label: '音频设备', editor: <AudioDevices /> },
]

export default function Settings() {
  const configuration = useQuery({
    queryKey: managementKeys.runningConfiguration,
    queryFn: useCallback((signal: AbortSignal) => api.getConfig(signal), []),
    pollInterval: false,
  })
  const navigate = useNavigate()
  const handleLogout = () => {
    useWSStore.getState().disconnect()
    clearToken()
    navigate('/login', { replace: true })
  }

  return <Page title="系统设置" eyebrow="工作空间配置" description="按服务管理参数，区分已保存配置与当前运行状态。"
    actions={<Button variant="outline" onClick={handleLogout}><LogOut className="w-4 h-4" />退出登录</Button>}>
    <ContentGrid variant="settings">
      <nav className="settings-navigation" aria-label="设置分区">
        {sections.map(section => <a key={section.id} href={'#' + section.id}>{section.label}</a>)}
        <a href="#runtime-configuration">运行配置</a>
      </nav>
      <div className="settings-content">
        {sections.map(section => <section key={section.id} id={section.id} aria-label={section.label}>{section.editor}</section>)}
        <section id="runtime-configuration" aria-label="运行配置">
          <Card>
            <CardHeader><CardTitle>当前配置（脱敏）</CardTitle>
              <p className="text-sm text-muted-foreground">当前进程的运行配置，仅供查看；已保存但待重启的修改在各分区中显示。</p>
            </CardHeader>
            <CardContent>
              <QueryWrapper loading={configuration.loading} error={configuration.error} onRetry={configuration.refresh}>
                {configuration.data && <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 font-mono text-card-foreground" tabIndex={0} aria-label="脱敏运行配置">{JSON.stringify(configuration.data, null, 2)}</pre>}
              </QueryWrapper>
            </CardContent>
          </Card>
        </section>
      </div>
    </ContentGrid>
  </Page>
}
