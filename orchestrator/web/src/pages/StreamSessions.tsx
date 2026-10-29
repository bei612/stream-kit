import { useCallback, useState } from 'react'
import { api } from '@/api/client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Crown, Mic, MicOff, RefreshCw, UserX, Unlock, Users } from 'lucide-react'

export default function StreamSessions() {
  const { data, loading, error, refresh } = useQuery({
    queryFn: useCallback(() => api.listStreamSessions(), []),
    pollInterval: 5000,
    wsInvalidateEvents: ['stream_session_created', 'stream_session_state_changed', 'stream_connection_changed', 'stream_connection_expired', 'stream_controller_changed'],
  })
  const [busy, setBusy] = useState('')
  const sessions = (data ?? []) as any[]

  const action = async (key: string, fn: () => Promise<any>) => {
    setBusy(key)
    try { await fn(); await refresh() } catch (e: any) { window.alert(e?.message || '操作失败') } finally { setBusy('') }
  }

  return (
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-2xl font-bold text-card-foreground">渲染会话</h2><p className="text-sm text-muted-foreground mt-1">统一查看客户端连接、控制权和麦克风状态</p></div>
          <Button variant="outline" onClick={() => refresh()} disabled={busy !== ''}><RefreshCw className="w-4 h-4" /> 刷新</Button>
        </div>
        {sessions.map((session) => {
          const connections = Object.values(session.connections || {}) as any[]
          return <Card key={session.session_id}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 mb-4">
              <div><div className="flex items-center gap-2"><h3 className="font-semibold text-card-foreground">Host {session.host_id} / App {session.app_id}</h3><StatusBadge status={session.state} /></div><div className="text-xs text-muted-foreground mt-1 font-mono">{session.session_id}</div></div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="w-4 h-4" />{connections.length}</span><span>上限 {session.policy?.max_viewers || '不限'}</span>{session.controller_connection_id ? <span className="inline-flex items-center gap-1 text-amber-400"><Crown className="w-4 h-4" />控制中</span> : <span>暂无控制者</span>}</div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {connections.map((connection) => {
                const isController = connection.connection_id === session.controller_connection_id
                const key = `${session.session_id}:${connection.connection_id}`
                return <div key={connection.connection_id} className="rounded-md border border-border p-3 space-y-3">
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-card-foreground truncate">{connection.user_id || '匿名客户端'}</div><div className="text-[11px] text-muted-foreground font-mono truncate">{connection.connection_id}</div></div>{isController && <Crown className="w-4 h-4 text-amber-400 shrink-0" />}</div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded bg-muted px-2 py-1">{connection.role}</span><span className="rounded bg-muted px-2 py-1">{connection.state}</span><span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1">{connection.microphone_live ? <Mic className="w-3 h-3 text-green-400" /> : <MicOff className="w-3 h-3" />}{connection.microphone_live ? '麦克风活动' : '麦克风关闭'}</span></div>
                  <div className="flex flex-wrap gap-2">{isController ? <Button size="sm" variant="outline" disabled={busy === key} onClick={() => action(key, () => api.releaseStreamController(session.session_id))}><Unlock className="w-3 h-3" /> 释放控制权</Button> : <Button size="sm" disabled={busy === key} onClick={() => action(key, () => api.claimStreamController(session.session_id, connection.connection_id))}><Crown className="w-3 h-3" /> 授予控制权</Button>}<Button size="sm" variant="destructive" disabled={busy === key} onClick={() => action(key, () => api.disconnectStreamConnection(session.session_id, connection.connection_id))}><UserX className="w-3 h-3" /> 踢出</Button></div>
                </div>
              })}
            </div>
            {connections.length === 0 && <div className="text-sm text-muted-foreground py-4 text-center">当前没有客户端连接</div>}
          </Card>
        })}
        {sessions.length === 0 && <div className="text-center text-muted-foreground py-12">当前没有活动渲染会话</div>}
      </div>
    </QueryWrapper>
  )
}
