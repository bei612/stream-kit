import { useCallback } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { useAppCommand } from '@/hooks/useAppCommand'
import { Alert } from '@/components/ui/alert'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import { ContentGrid, EmptyState, Page } from '@/components/layout/Page'
import StatusBadge from '@/components/StatusBadge'
import { Button, LinkButton } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatBytes, formatTime } from '@/lib/utils'
import { openViewingStream } from '@/lib/stream-access'
import { Play, Square, Upload, ArrowUpRight, Users, Monitor } from 'lucide-react'
import { useManagementLocale } from '@/i18n'

export default function Apps() {
  const { t } = useManagementLocale()
  const { data, loading, error, refresh } = useQuery({
    queryKey: managementKeys.apps,
    queryFn: useCallback((signal: AbortSignal) => api.listApps(signal), []),
    pollInterval: 10000,
    wsInvalidateEvents: ['app_status', 'stream_session_state_changed', 'stream_session_created'],
  })

  const apps = data ?? []

  const command = useAppCommand(refresh)
  const handleLaunch = (id: string) => command.run(id, 'launch', async () => {
    await openViewingStream(async () => (await api.launchApp(id)).data?.stream_url)
  })
  const handleStop = (id: string) => command.run(id, 'stop', async () => { await api.stopApp(id) })

  return (
    <Page title={t('apps.title')} eyebrow={t('apps.eyebrow')} description={t('apps.description')} actions={<LinkButton to="/upload" variant="primary"><Upload className="w-4 h-4" />{t('apps.add')}</LinkButton>}>
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
        {command.error && <Alert variant="error" role="alert">{command.error}</Alert>}

        {apps.length === 0 ? (
          <EmptyState title={t('apps.empty')} description={t('apps.emptyDescription')} action={<LinkButton to="/upload" variant="primary">{t('apps.add')}</LinkButton>} />
        ) : (
          <ContentGrid>
            {apps.map(app => {
              const pending = command.pending[app.id]
              return <Card key={app.id} className="flex min-w-0 flex-col gap-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <div className="rounded-lg bg-primary/10 p-2.5 text-primary self-start"><Monitor className="h-5 w-5" /></div>
                    <div className="min-w-0"><Link to={`/apps/${app.id}`} className="block break-words text-base font-semibold hover:text-primary">{app.name}</Link>
                      <p className="mt-1 text-xs text-muted-foreground">{app.source === 'local' ? t('apps.local') : t('apps.uploaded')} · {app.capture_mode === 'application' ? t('apps.applicationCapture') : t('apps.desktopCapture')}</p>
                    </div>
                  </div>
                  <div className="shrink-0"><StatusBadge status={app.status} /></div>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="truncate" title={app.exe_path || app.exe_relative_path}>{t('apps.entry')}: {app.exe_path || app.exe_relative_path || t('apps.pendingConfiguration')}</p>
                  <p>{t('apps.addedAt')} {formatTime(app.created_at)}{app.source !== 'local' && ` · ${formatBytes(app.extracted_size_bytes || app.file_size_bytes)}`}</p>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
                  {app.lifecycle?.can_launch && <Button size="sm" disabled={!!pending} onClick={() => handleLaunch(app.id)}><Play className="h-3.5 w-3.5" />{pending === 'launch' ? t('apps.opening') : app.status === 'running' ? t('apps.enterStream') : t('apps.startStream')}</Button>}
                  {app.lifecycle?.can_stop && <Button size="sm" variant="outline" disabled={!!pending} onClick={() => handleStop(app.id)}><Square className="h-3.5 w-3.5" />{pending === 'stop' ? t('apps.stopping') : t('apps.stopStream')}</Button>}
                  <Link to={`/apps/${app.id}`} className="inline-flex min-h-9 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary">{t('apps.configureLink')} <ArrowUpRight className="h-3.5 w-3.5" /></Link>
                  <Link to={`/stream-sessions?app=${encodeURIComponent(app.id)}`} className="inline-flex min-h-9 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary"><Users className="h-3.5 w-3.5" />{t('apps.clients')}</Link>
                </div>
              </Card>
            })}
          </ContentGrid>
        )}
    </QueryWrapper>
    </Page>
  )
}
