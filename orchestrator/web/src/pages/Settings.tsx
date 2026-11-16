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
import { useManagementLocale } from '@/i18n'

export default function Settings() {
  const { t } = useManagementLocale()
  const sections = [
    { id: 'service-settings', label: t('settings.service'), editor: <ConfigurationEditor /> },
    { id: 'render-nodes', label: t('settings.nodes'), editor: <RenderNodes /> },
    { id: 'gateway-settings', label: t('settings.gateway'), editor: <GatewayConfigurationEditor /> },
    { id: 'encoder-settings', label: t('settings.encoder'), editor: <EncoderConfigurationEditor /> },
    { id: 'audio-devices', label: t('settings.audio'), editor: <AudioDevices /> },
  ]
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

  return <Page title={t('settings.title')} eyebrow={t('settings.eyebrow')} description={t('settings.description')}
    actions={<Button variant="outline" onClick={handleLogout}><LogOut className="w-4 h-4" />{t('settings.logout')}</Button>}>
    <ContentGrid variant="settings">
      <nav className="settings-navigation" aria-label={t('settings.sections')}>
        {sections.map(section => <a key={section.id} href={'#' + section.id}>{section.label}</a>)}
        <a href="#runtime-configuration">{t('settings.runtime')}</a>
      </nav>
      <div className="settings-content">
        {sections.map(section => <section key={section.id} id={section.id} aria-label={section.label}>{section.editor}</section>)}
        <section id="runtime-configuration" aria-label={t('settings.runtime')}>
          <Card>
            <CardHeader><CardTitle>{t('settings.currentSanitized')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('settings.currentDescription')}</p>
            </CardHeader>
            <CardContent>
              <QueryWrapper loading={configuration.loading} error={configuration.error} onRetry={configuration.refresh}>
                {configuration.data && <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 font-mono text-card-foreground" tabIndex={0} aria-label={t('settings.currentSanitized')}>{JSON.stringify(configuration.data, null, 2)}</pre>}
              </QueryWrapper>
            </CardContent>
          </Card>
        </section>
      </div>
    </ContentGrid>
  </Page>
}
