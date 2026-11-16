import { useCallback, useMemo } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import { ContentGrid, EmptyState, Metric, Page } from '@/components/layout/Page'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { LinkButton } from '@/components/ui/button'
import { Upload, ExternalLink } from 'lucide-react'
import { useManagementLocale, type MessageKey } from '@/i18n'

function componentDisplayName(name: string, t: (key: MessageKey) => string) {
  if (name === 'sunshine') return t('dashboard.encoder')
  if (name === 'web_server') return t('dashboard.gateway')
  return name
}

export default function Dashboard() {
  const { t } = useManagementLocale()
  const health = useQuery({ queryKey: managementKeys.health, queryFn: api.health, pollInterval: 15000 })
  const comps = useQuery({
    queryKey: managementKeys.components,
    queryFn: useCallback((signal: AbortSignal) => api.listComponents(signal), []),
    pollInterval: 5000,
    wsInvalidateEvents: ['component_status'],
  })
  const apps = useQuery({
    queryKey: managementKeys.apps,
    queryFn: useCallback((signal: AbortSignal) => api.listApps(signal), []),
    pollInterval: 10000,
    wsInvalidateEvents: ['app_status'],
  })

  const appStats = useMemo(() => {
    const appList = apps.data ?? []
    return {
    total: appList.length,
    running: appList.filter(a => a.status === 'running').length,
    ready: appList.filter(a => a.status === 'ready').length,
    error: appList.filter(a => ['error', 'crashed', 'register_failed'].includes(a.status)).length,
    }
  }, [apps.data])

  const components = comps.data ?? []

  return (
    <Page title={t('dashboard.title')} eyebrow={t('dashboard.eyebrow')} description={t('dashboard.description')} actions={<LinkButton to="/stream-sessions">{t('dashboard.manageSessions')} <ExternalLink size={15} /></LinkButton>}>
    <QueryWrapper loading={comps.loading || apps.loading} error={comps.error || apps.error} onRetry={() => { comps.refresh(); apps.refresh() }}>

        {/* Component status cards */}
        <ContentGrid>
          {components.map(c => (
            <Card key={c.name}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-card-foreground">{componentDisplayName(c.name, t)}</span>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-xs text-muted-foreground">PID: {c.pid || '-'}</div>
            <Link to={`/components#${encodeURIComponent(c.name)}`} className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline">{t('dashboard.manageComponent')} <ExternalLink className="h-3 w-3" /></Link>
            </Card>
          ))}
          {components.length === 0 && !comps.loading && (
            <EmptyState title={t('dashboard.noComponents')} description={t('dashboard.noComponentsDescription')} />
          )}
        </ContentGrid>

        {/* App overview */}
        <ContentGrid variant="metrics">
          {[
            { label: t('dashboard.totalApps'), value: appStats.total, color: 'text-foreground' },
            { label: t('dashboard.runningApps'), value: appStats.running, color: 'text-green-500' },
            { label: t('dashboard.readyApps'), value: appStats.ready, color: 'text-blue-500' },
            { label: t('dashboard.errorApps'), value: appStats.error, color: 'text-red-300' },
          ].map(({ label, value, color }) => (
            <Metric key={label} label={label} value={value} className={color} />
          ))}
        </ContentGrid>

        <div className="action-row">
          <LinkButton to="/upload" variant="primary"><Upload className="w-4 h-4" /> {t('dashboard.addApp')}</LinkButton>
          <LinkButton to="/apps"><ExternalLink className="w-4 h-4" /> {t('dashboard.appList')}</LinkButton>
        </div>

        {health.data && (
          <div className="break-all text-xs text-muted-foreground">
            {t('dashboard.version')}: {health.data.version} ({health.data.commit})
          </div>
        )}
    </QueryWrapper>
    </Page>
  )
}
