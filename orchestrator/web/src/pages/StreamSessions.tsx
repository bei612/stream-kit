import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api/client'
import { currentMediaObservation, type MediaObservation, type RenderSession, type SessionAudio } from '@/api/sessions'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Crown, Mic, MicOff, RefreshCw, UserX, Unlock, Users } from 'lucide-react'

type Action = (operation: () => Promise<unknown>) => Promise<void>

function MediaRuntime({ observation }: { observation?: MediaObservation }) {
  if (!observation) return <p role="status" className="text-sm text-amber-400 mb-4">媒体运行状态未确认，等待网关最新反馈。</p>
  const target = observation.microphone_target
  const labels: Record<MediaObservation['microphone_target']['state'], string> = {
    unconfigured: '未配置可用的目标录音输入',
    idle: '已配置目标录音输入，当前未运行',
    device_open: '目标输入设备已打开',
    device_failed: '目标输入设备故障',
    upstream_transport: '上游支持麦克风传输',
  }
  return <div role="status" className="rounded-md border border-border p-3 mb-4 space-y-2 text-sm">
    <p>{observation.upstream_active ? '共享上游运行中' : '共享上游未运行'} · 媒体订阅数 {observation.subscribers}</p>
    <p className={target.state === 'device_failed' || target.state === 'unconfigured' ? 'text-amber-400' : ''}>{labels[target.state]}</p>
    {target.device && <p className="text-xs text-muted-foreground">设备处理采样数（含静音）{target.device.device_sample_frames} · 队列丢帧 {target.device.dropped_frames} · 缓冲异常 {target.device.xruns}</p>}
    {target.device?.realtime_denied && <p className="text-xs text-amber-400">设备未获得实时调度权限，需关注音频稳定性。</p>}
    {target.device?.error && <p className="text-xs text-red-400">{target.device.error}</p>}
    <p className="text-xs text-muted-foreground">设备和传输状态不代表目标程序已录到声音。目标录音与观众收听需分别验证。</p>
  </div>
}

function AudioSettings({ session, busy, action }: { session: RenderSession; busy: boolean; action: Action }) {
  const [audio, setAudio] = useState<SessionAudio>(session.audio)
  const [capacity, setCapacity] = useState(session.policy.max_viewers)
  return <div className="border-t border-border mt-4 pt-4 grid gap-6 lg:grid-cols-2">
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void action(() => api.updateStreamAudio(session.session_id, audio)) }}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="font-medium mb-2">音频设置</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={audio.microphone_enabled} onChange={(e) => setAudio({ ...audio, microphone_enabled: e.target.checked })} />允许控制者麦克风</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={audio.broadcast_controller_microphone} onChange={(e) => setAudio({ ...audio, broadcast_controller_microphone: e.target.checked })} />向观众广播麦克风</label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">程序音量（dB）<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={-60} max={12} step={1} value={audio.program_gain_db} onChange={(e) => setAudio({ ...audio, program_gain_db: e.target.valueAsNumber })} /></label>
          <label className="flex items-center gap-2">麦克风音量（dB）<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={-60} max={12} step={1} value={audio.microphone_gain_db} onChange={(e) => setAudio({ ...audio, microphone_gain_db: e.target.valueAsNumber })} /></label>
        </div>
        <Button size="sm" type="submit">应用音频设置</Button>
      </fieldset>
    </form>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void action(() => api.updateStreamPolicy(session.session_id, { ...session.policy, max_viewers: capacity })) }}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="font-medium mb-2">连接容量</legend>
        <label className="flex items-center gap-2 text-sm">最大客户端数<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={0} step={1} value={capacity} onChange={(e) => setCapacity(e.target.valueAsNumber)} /></label>
        <p className="text-xs text-muted-foreground">0 表示不限制。降低上限后，已有连接保留，新连接按新上限准入。</p>
        <Button size="sm" type="submit">应用连接容量</Button>
      </fieldset>
    </form>
  </div>
}

export default function StreamSessions() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Expire displayed evidence even while a poll is stalled or offline.
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { data, loading, error, refresh } = useQuery({
    queryFn: useCallback(() => api.listStreamSessions(), []),
    pollInterval: 5000,
    wsInvalidateEvents: ['stream_session_created', 'stream_session_state_changed', 'stream_connection_changed', 'stream_connection_expired', 'stream_controller_changed', 'stream_audio_changed', 'stream_policy_changed'],
  })
  const media = useQuery({ queryFn: useCallback(() => api.getMediaControl(), []), pollInterval: 2000 })
  const [busy, setBusy] = useState(false)
  const [commandError, setCommandError] = useState('')
  const sessions = data ?? []
  const action: Action = async (operation) => {
    setBusy(true)
    setCommandError('')
    try { await operation() }
    catch (e: unknown) { setCommandError(e instanceof Error ? e.message : '操作失败') }
    finally { await refresh(); await media.refresh(); setBusy(false) }
  }

  return <QueryWrapper loading={loading} error={error} onRetry={refresh}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-2xl font-bold text-card-foreground">渲染会话</h2><p className="text-sm text-muted-foreground mt-1">统一管理客户端连接、控制权和音频</p></div>
        <Button variant="outline" onClick={() => { void refresh(); void media.refresh() }} disabled={busy}><RefreshCw className="w-4 h-4" /> 刷新</Button>
      </div>
      {commandError && <p role="alert" className="text-sm text-red-400">{commandError}</p>}
      {(media.error || (media.data && !media.data.reachable)) && <p role="status" className="text-sm text-amber-400">媒体网关同步异常，正在重试。请查看各会话的生效状态。</p>}
      {sessions.map((session) => {
        const connections = Object.values(session.connections)
        const appliedRevision = media.data?.applied_revisions[session.session_id] ?? 0
        const leaseValid = media.data?.lease_valid && media.data.lease_expires_at_ms > now
        const applied = leaseValid && appliedRevision >= session.revision
        return <Card key={session.session_id}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 mb-4">
            <div>
              <div className="flex items-center gap-2"><h3 className="font-semibold text-card-foreground">Host {session.host_id} / App {session.app_id}</h3><StatusBadge status={session.state} /></div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">{session.session_id}</div>
              <p role="status" className={`text-xs mt-2 ${applied ? 'text-green-400' : 'text-amber-400'}`}>{applied ? '媒体网关已应用' : leaseValid ? '已保存，等待媒体网关应用' : '媒体网关未就绪'} · 已保存版本 {session.revision} / 已应用版本 {appliedRevision}</p>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="w-4 h-4" />{connections.length}</span><span>上限 {session.policy.max_viewers || '不限'}</span><span>{session.controller_connection_id ? '控制中' : '暂无控制者'}</span></div>
          </div>
          <MediaRuntime observation={media.error ? undefined : currentMediaObservation(media.data, session, now)} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {connections.map((connection) => {
              const isController = connection.connection_id === session.controller_connection_id
              const expired = Date.parse(connection.expires_at) <= now
              return <div key={connection.connection_id} className="rounded-md border border-border p-3 space-y-3">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-card-foreground truncate">{connection.user_id || '匿名客户端'}</div><div className="text-[11px] text-muted-foreground font-mono truncate">{connection.connection_id}</div></div>{isController && <Crown className="w-4 h-4 text-amber-400 shrink-0" />}</div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{isController ? '控制者' : '观众'}</span><span>{expired ? '连接已过期' : '已连接'}</span><span className="inline-flex items-center gap-1">{connection.microphone_live ? <Mic className="w-3 h-3 text-green-400" /> : <MicOff className="w-3 h-3" />}{connection.microphone_live ? '客户端报告麦克风活动' : '麦克风未活动'}</span></div>
                <div className="flex flex-wrap gap-2">
                  {isController
                    ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => api.releaseStreamController(session.session_id))}><Unlock className="w-3 h-3" />释放控制权</Button>
                    : <Button size="sm" disabled={busy || expired} onClick={() => void action(() => api.transferStreamController(session.session_id, connection.connection_id, session.controller_connection_id ?? '', session.control_epoch))}><Crown className="w-3 h-3" />{session.controller_connection_id ? '转移控制权' : '授予控制权'}</Button>}
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void action(() => api.disconnectStreamConnection(session.session_id, connection.connection_id))}><UserX className="w-3 h-3" />断开连接</Button>
                </div>
              </div>
            })}
          </div>
          {connections.length === 0 && <div className="text-sm text-muted-foreground py-4 text-center">当前没有客户端连接</div>}
          <AudioSettings key={`${JSON.stringify(session.audio)}:${JSON.stringify(session.policy)}`} session={session} busy={busy} action={action} />
        </Card>
      })}
      {sessions.length === 0 && <div className="text-center text-muted-foreground py-12">当前没有渲染会话</div>}
    </div>
  </QueryWrapper>
}
