import { useCallback } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/client'
import { useAppCommand } from '@/hooks/useAppCommand'
import { Alert } from '@/components/ui/alert'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatBytes, formatTime } from '@/lib/utils'
import { openViewingStream } from '@/lib/stream-access'
import { Play, Square, Upload, ArrowUpRight, Users, Monitor } from 'lucide-react'

export default function Apps() {
  const { data, loading, error, refresh } = useQuery({
    queryFn: useCallback(() => api.listApps(), []),
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
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <div className="space-y-4">
        {command.error && <Alert variant="error" role="alert">{command.error}</Alert>}
        <div className="page-heading">
          <div><p className="page-eyebrow">渲染内容</p><h2>应用管理</h2><p className="page-description">管理上传包和本机程序，启动或结束串流。</p></div>
          <Link to="/upload">
            <Button>
              <Upload className="w-4 h-4" /> 添加应用
            </Button>
          </Link>
        </div>

        {apps.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-lg mb-2">暂无应用</p>
            <p className="text-sm">点击“添加应用”，上传压缩包或指定本机程序路径</p>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {apps.map(app => {
              const pending = command.pending[app.id]
              return <Card key={app.id} className="flex min-w-0 flex-col gap-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <div className="rounded-lg bg-primary/10 p-2.5 text-primary self-start"><Monitor className="h-5 w-5" /></div>
                    <div className="min-w-0"><Link to={`/apps/${app.id}`} className="block break-words text-base font-semibold hover:text-primary">{app.name}</Link>
                      <p className="mt-1 text-xs text-muted-foreground">{app.source === 'local' ? '本机程序' : '上传应用'} · {app.capture_mode === 'application' ? '指定程序采集' : '桌面采集'}</p>
                    </div>
                  </div>
                  <div className="shrink-0"><StatusBadge status={app.status} /></div>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="truncate" title={app.exe_path || app.exe_relative_path}>入口：{app.exe_path || app.exe_relative_path || '等待配置'}</p>
                  <p>添加于 {formatTime(app.created_at)}{app.source !== 'local' && ` · ${formatBytes(app.extracted_size_bytes || app.file_size_bytes)}`}</p>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
                  {app.lifecycle?.can_launch && <Button size="sm" disabled={!!pending} onClick={() => handleLaunch(app.id)}><Play className="h-3.5 w-3.5" />{pending === 'launch' ? '正在打开…' : app.status === 'running' ? '进入串流' : '启动串流'}</Button>}
                  {app.lifecycle?.can_stop && <Button size="sm" variant="outline" disabled={!!pending} onClick={() => handleStop(app.id)}><Square className="h-3.5 w-3.5" />{pending === 'stop' ? '正在停止…' : '停止串流'}</Button>}
                  <Link to={`/apps/${app.id}`} className="inline-flex min-h-9 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary">配置与观看链接 <ArrowUpRight className="h-3.5 w-3.5" /></Link>
                  <Link to={`/stream-sessions?app=${encodeURIComponent(app.id)}`} className="inline-flex min-h-9 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary"><Users className="h-3.5 w-3.5" />客户端</Link>
                </div>
              </Card>
            })}
          </div>
        )}
      </div>
    </QueryWrapper>
  )
}
