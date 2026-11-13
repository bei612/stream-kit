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

const componentNames: Record<string, string> = {
  sunshine: '串流编码器',
  web_server: '串流网关',
}
function componentDisplayName(name: string) {
  return componentNames[name] || name
}

export default function Dashboard() {
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
    <Page title="工作台" eyebrow="工作空间总览" description="查看服务与应用状态，开始或管理一场串流。" actions={<LinkButton to="/stream-sessions">管理渲染会话 <ExternalLink size={15} /></LinkButton>}>
    <QueryWrapper loading={comps.loading || apps.loading} error={comps.error || apps.error} onRetry={() => { comps.refresh(); apps.refresh() }}>

        {/* Component status cards */}
        <ContentGrid>
          {components.map(c => (
            <Card key={c.name}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-card-foreground">{componentDisplayName(c.name)}</span>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-xs text-muted-foreground">PID: {c.pid || '-'}</div>
              <Link to={`/components#${encodeURIComponent(c.name)}`} className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline">管理组件 <ExternalLink className="h-3 w-3" /></Link>
            </Card>
          ))}
          {components.length === 0 && !comps.loading && (
            <EmptyState title="未配置任何组件" description="在系统设置中核对组件配置。" />
          )}
        </ContentGrid>

        {/* App overview */}
        <ContentGrid variant="metrics">
          {[
            { label: '应用总数', value: appStats.total, color: 'text-foreground' },
            { label: '运行中', value: appStats.running, color: 'text-green-500' },
            { label: '就绪', value: appStats.ready, color: 'text-blue-500' },
            { label: '异常', value: appStats.error, color: 'text-red-300' },
          ].map(({ label, value, color }) => (
            <Metric key={label} label={label} value={value} className={color} />
          ))}
        </ContentGrid>

        <div className="action-row">
          <LinkButton to="/upload" variant="primary"><Upload className="w-4 h-4" /> 添加应用</LinkButton>
          <LinkButton to="/apps"><ExternalLink className="w-4 h-4" /> 应用列表</LinkButton>
        </div>

        {health.data && (
          <div className="break-all text-xs text-muted-foreground">
            版本: {health.data.version} ({health.data.commit})
          </div>
        )}
    </QueryWrapper>
    </Page>
  )
}
