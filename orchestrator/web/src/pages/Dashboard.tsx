import { useCallback, useMemo } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Play, Square, Upload, ExternalLink } from 'lucide-react'

const componentNames: Record<string, string> = {
  sunshine: '串流编码器',
  web_server: '串流网关',
}
function componentDisplayName(name: string) {
  return componentNames[name] || name
}

export default function Dashboard() {
  const health = useQuery({ queryFn: api.health, pollInterval: 15000 })
  const comps = useQuery({
    queryFn: useCallback(() => api.listComponents(), []),
    pollInterval: 5000,
    wsInvalidateEvents: ['component_status'],
  })
  const apps = useQuery({
    queryFn: useCallback(() => api.listApps(), []),
    pollInterval: 10000,
    wsInvalidateEvents: ['app_status'],
  })

  const appList = apps.data ?? []
  const appStats = useMemo(() => ({
    total: appList.length,
    running: appList.filter((a: any) => a.status === 'running').length,
    ready: appList.filter((a: any) => a.status === 'ready').length,
    error: appList.filter((a: any) => ['error', 'crashed', 'register_failed'].includes(a.status)).length,
  }), [appList])

  const components = comps.data ?? []

  return (
    <QueryWrapper loading={comps.loading && apps.loading} error={comps.error || apps.error} onRetry={() => { comps.refresh(); apps.refresh() }}>
      <div className="space-y-6">
        <div className="page-heading"><div><p className="page-eyebrow">工作空间总览</p><h2>工作台</h2><p className="page-description">查看服务与应用状态，开始或管理一场串流。</p></div><Link to="/stream-sessions"><Button variant="outline">管理渲染会话 <ExternalLink size={15} /></Button></Link></div>

        {/* Component status cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(components as any[]).map((c: any) => (
            <Card key={c.name}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-card-foreground">{componentDisplayName(c.name)}</span>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-xs text-muted-foreground">PID: {c.pid || '-'}</div>
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  onClick={() => api.startComponent(c.name).then(comps.refresh)}
                  disabled={c.status === 'running'}
                >
                  <Play className="w-3 h-3" /> 启动
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => api.stopComponent(c.name).then(comps.refresh)}
                  disabled={c.status === 'stopped'}
                >
                  <Square className="w-3 h-3" /> 停止
                </Button>
              </div>
            </Card>
          ))}
          {components.length === 0 && !comps.loading && (
            <div className="col-span-3 text-center text-muted-foreground py-8">未配置任何组件</div>
          )}
        </div>

        {/* App overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: '应用总数', value: appStats.total, color: 'text-foreground' },
            { label: '运行中', value: appStats.running, color: 'text-green-500' },
            { label: '就绪', value: appStats.ready, color: 'text-blue-500' },
            { label: '异常', value: appStats.error, color: 'text-red-300' },
          ].map(({ label, value, color }) => (
            <Card key={label}>
              <div className={`text-3xl font-bold ${color}`}>{value}</div>
              <div className="text-xs text-muted-foreground mt-1">{label}</div>
            </Card>
          ))}
        </div>

        <div className="flex gap-3">
          <Link to="/upload">
            <Button>
              <Upload className="w-4 h-4" /> 上传应用
            </Button>
          </Link>
          <Link to="/apps">
            <Button variant="outline">
              <ExternalLink className="w-4 h-4" /> 应用列表
            </Button>
          </Link>
        </div>

        {health.data && (
          <div className="text-xs text-muted-foreground">
            版本: {(health.data as any).version} ({(health.data as any).commit})
          </div>
        )}
      </div>
    </QueryWrapper>
  )
}
