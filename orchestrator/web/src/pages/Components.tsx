import { useState, useCallback } from 'react'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { useQuery } from '@/hooks/useQuery'
import { useResourceCommand } from '@/hooks/useAppCommand'
import QueryWrapper from '@/components/QueryWrapper'
import { ContentGrid, EmptyState, Page } from '@/components/layout/Page'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Play, Square, RotateCcw } from 'lucide-react'
import { formatDuration } from '@/lib/utils'

const componentNames: Record<string, string> = {
  sunshine: '串流编码器',
  web_server: '串流网关',
}
type ComponentCommand = 'start' | 'stop' | 'restart'
function componentDisplayName(name: string) {
  return componentNames[name] || name
}

export default function Components() {
  const { data, loading, error, refresh } = useQuery({
    queryKey: managementKeys.components,
    queryFn: useCallback((signal: AbortSignal) => api.listComponents(signal), []),
    pollInterval: 5000,
    wsInvalidateEvents: ['component_status'],
  })
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const command = useResourceCommand<ComponentCommand>(refresh)
  const [logErrors, setLogErrors] = useState<Record<string, string>>({})

  const components = data ?? []

  const loadLogs = async (name: string) => {
    setLogErrors(previous => ({ ...previous, [name]: '' }))
    try {
      const res = await api.getComponentLogs(name, 50)
      setLogs(prev => ({ ...prev, [name]: res.data || [] }))
    } catch (e: unknown) {
      setLogErrors(previous => ({ ...previous, [name]: e instanceof Error ? e.message : '读取组件日志失败' }))
    }
  }

  return (
    <Page title="组件管理" eyebrow="运行服务" description="管理编码器与媒体网关，查看运行状态和日志。">
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <ContentGrid>
        {components.map(c => {
          const pending = command.pending[c.name]
          const uptime = ['running', 'starting', 'unhealthy'].includes(c.status) && c.started_at && !c.started_at.startsWith('0001')
            ? Math.floor((Date.now() - new Date(c.started_at).getTime()) / 1000)
            : 0

          return (
            <Card key={c.name} id={c.name}>
              <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                <div>
                  <span className="text-lg font-medium capitalize text-card-foreground">
                    {componentDisplayName(c.name)}
                  </span>
                  <span className="ml-3"><StatusBadge status={c.status} /></span>
                </div>
                <div className="action-row">
                  <Button size="sm" onClick={() => void command.run(c.name, 'start', () => api.startComponent(c.name))} disabled={!!pending || ['running','starting','unhealthy'].includes(c.status) || c.pid > 0}>
                    <Play className="w-3 h-3" /> {pending === 'start' ? '正在启动…' : '启动'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void command.run(c.name, 'stop', () => api.stopComponent(c.name))} disabled={!!pending || c.status === 'stopped'}>
                    <Square className="w-3 h-3" /> {pending === 'stop' ? '正在停止…' : '停止'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void command.run(c.name, 'restart', () => api.restartComponent(c.name))} disabled={!!pending}>
                    <RotateCcw className="w-3 h-3" /> {pending === 'restart' ? '正在重启…' : '重启'}
                  </Button>
                </div>
              </div>

              <div className="component-facts text-sm text-muted-foreground mb-3">
                <div>PID: <span className="text-card-foreground">{c.pid || '-'}</span></div>
                <div>运行时长: <span className="text-card-foreground">{uptime > 0 ? formatDuration(uptime) : '-'}</span></div>
                <div>崩溃次数: <span className="text-card-foreground">{c.crash_count}</span></div>
              </div>

              {c.last_error && !command.errors[c.name] && <div className="text-xs text-red-300 mb-2">错误: {c.last_error}</div>}
              {command.errors[c.name] && <Alert role="alert" variant="error">{command.errors[c.name]}</Alert>}
              {pending && <p className="text-xs text-muted-foreground mb-2" role="status">正在执行组件操作，启停结果以健康检查状态为准。</p>}

              <div>
                <button onClick={() => loadLogs(c.name)} className="text-xs text-primary hover:underline mb-1">加载日志</button>
                {logErrors[c.name] && <Alert role="alert" variant="error">{logErrors[c.name]}</Alert>}
                {logs[c.name] && (
                  <div className="bg-black text-green-400 text-xs font-mono p-3 rounded max-h-48 overflow-auto min-w-0 break-all" role="region" aria-label={`${componentDisplayName(c.name)}日志`} tabIndex={0}>
                    {logs[c.name].length === 0
                      ? <div className="text-muted-foreground">暂无日志</div>
                      : logs[c.name].map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                )}
              </div>
            </Card>
          )
        })}

      </ContentGrid>
      {components.length === 0 && <EmptyState title="未配置任何组件" description="请在系统设置中核对编码器与网关配置。" />}
    </QueryWrapper>
    </Page>
  )
}
