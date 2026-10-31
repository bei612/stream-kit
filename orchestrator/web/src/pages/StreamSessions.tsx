import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api/client'
import { currentMediaObservation, type MediaObservation, type RenderSession, type SessionAudio } from '@/api/sessions'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AudioTargetSettings } from '@/components/AudioTargetSettings'
import { Crown, Mic, MicOff, RefreshCw, UserX, Unlock, Users } from 'lucide-react'

type Action = (operation: () => Promise<unknown>) => Promise<void>

function MediaRuntime({ observation }: { observation?: MediaObservation }) {
  if (!observation) return <p role="status" className="text-sm text-amber-400 mb-4">媒体运行状态未确认，等待网关最新反馈。</p>
  const target = observation.microphone_target
  const labels: Record<MediaObservation['microphone_target']['state'], string> = {
    unconfigured: '未配置可用的目标录音输入',
    idle: '会话当前未运行，音频目标待启动',
    pending: '音频目标正在切换',
    disabled: '已关闭向目标程序发送麦克风',
    device_open: '目标输入设备已打开',
    device_failed: '目标输入设备故障',
    upstream_transport: '上游支持麦克风传输',
  }
  return <div role="status" className="runtime-strip">
    <p>{observation.upstream_active ? '共享上游运行中' : '共享上游未运行'} · 媒体订阅数 {observation.subscribers}</p>
    <p className={target.state === 'device_failed' || target.state === 'unconfigured' ? 'text-amber-400' : ''}>{labels[target.state]}</p>
    {target.device && <details><summary>音频设备详情</summary><p className="mt-2">设备处理采样数（含静音）{target.device.device_sample_frames} · 队列丢帧 {target.device.dropped_frames} · 缓冲异常 {target.device.xruns}</p></details>}
    {target.device?.realtime_denied && <p className="text-xs text-amber-400">设备未获得实时调度权限，需关注音频稳定性。</p>}
    {target.device?.error && <p className="text-xs text-red-400">{target.device.error}</p>}
    {target.error && <p className="text-xs text-red-400">{target.error}</p>}
    <p className="text-xs text-muted-foreground">向目标程序送入语音时，请在程序中选择对应的录音输入设备。</p>
  </div>
}

function AudioSettings({ session, busy, action }: { session: RenderSession; busy: boolean; action: Action }) {
  const [audio, setAudio] = useState<SessionAudio>(session.audio)
  const [baseline, setBaseline] = useState<SessionAudio>(session.audio)
  const sameAudio = (a: SessionAudio, b: SessionAudio) => a.program_gain_db === b.program_gain_db && a.microphone_gain_db === b.microphone_gain_db && a.microphone_enabled === b.microphone_enabled && a.broadcast_controller_microphone === b.broadcast_controller_microphone && a.controller_monitor === b.controller_monitor
  const dirty = !sameAudio(audio, baseline)
  const stale = !sameAudio(baseline, session.audio)
  useEffect(() => {
    if (!dirty) { setAudio(session.audio); setBaseline(session.audio) }
  }, [session.audio, dirty])
  const [capacity, setCapacity] = useState(session.policy.max_viewers)
  const [policyBase, setPolicyBase] = useState(session.policy)
  const capacityDirty = capacity !== policyBase.max_viewers
  const policyStale = policyBase.max_viewers !== session.policy.max_viewers || policyBase.controller_disconnect_policy !== session.policy.controller_disconnect_policy || policyBase.allow_viewer_microphone !== session.policy.allow_viewer_microphone
  useEffect(() => {
    if (!capacityDirty) { setCapacity(session.policy.max_viewers); setPolicyBase(session.policy) }
  }, [session.policy, capacityDirty])
  return <div className="border-t border-border mt-4 pt-4 grid gap-6 lg:grid-cols-2">
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (stale) return; void action(async () => {
      const result = await api.updateStreamAudio(session.session_id, audio, baseline)
      if (result.data) { setAudio(result.data.audio); setBaseline(result.data.audio) }
      return result
    }) }}>
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
        {stale && <p role="alert" className="text-sm text-amber-400">音频配置已更新，当前草稿未覆盖服务器设置。请载入最新配置后重新编辑。</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={stale}>应用音频设置</Button>
          {(dirty || stale) && <Button size="sm" type="button" variant="outline" onClick={() => {setAudio(session.audio);setBaseline(session.audio)}}>载入最新音频配置</Button>}
        </div>
      </fieldset>
    </form>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (policyStale) return; void action(async () => {
      const result = await api.updateStreamPolicy(session.session_id, { ...policyBase, max_viewers: capacity }, policyBase)
      if (result.data) { setCapacity(result.data.policy.max_viewers); setPolicyBase(result.data.policy) }
      return result
    }) }}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="font-medium mb-2">连接容量</legend>
        <label className="flex items-center gap-2 text-sm">最大客户端数<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={0} step={1} value={capacity} onChange={(e) => setCapacity(e.target.valueAsNumber)} /></label>
        <p className="text-xs text-muted-foreground">0 表示不限制。降低上限后，已有连接保留，新连接按新上限准入。</p>
        <p className="text-xs text-muted-foreground">控制者连接租约到期后释放控制权；恢复连接后作为观众，由管理员重新授权。观众不能发送麦克风或控制输入。</p>
        {policyStale && <p role="alert" className="text-sm text-amber-400">连接配置已更新，当前容量草稿已保留。请载入最新配置后重新编辑。</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={policyStale}>应用连接容量</Button>
          {(capacityDirty || policyStale) && <Button size="sm" type="button" variant="outline" onClick={() => {setCapacity(session.policy.max_viewers);setPolicyBase(session.policy)}}>载入最新连接配置</Button>}
        </div>
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
      <div className="page-heading">
        <div><p className="page-eyebrow">连接与协作</p><h2>渲染会话</h2><p className="page-description">查看连接状态，分配唯一控制权，实时调整音频。</p></div>
        <Button variant="outline" onClick={() => { void refresh(); void media.refresh() }} disabled={busy}><RefreshCw className="w-4 h-4" /> 刷新</Button>
      </div>
      <div className="session-summary" aria-label="会话概览">
        <div><strong>{sessions.length}</strong><span>渲染会话</span></div>
        <div><strong>{sessions.reduce((total, session) => total + Object.keys(session.connections).length, 0)}</strong><span>客户端连接</span></div>
        <div><strong>{sessions.filter(session => session.controller_connection_id).length}</strong><span>已分配控制权</span></div>
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
              <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-card-foreground" title={session.session_id}>会话 {session.session_id.slice(0, 8)}</h3><StatusBadge status={session.state} /></div>
              <div className="text-xs text-muted-foreground mt-1">主机 {session.host_id} · 应用 {session.app_id}</div>
              <p role="status" className={`text-xs mt-2 ${applied ? 'text-green-400' : 'text-amber-400'}`}>{applied ? '媒体网关已应用' : leaseValid ? '已保存，等待媒体网关应用' : '媒体网关未就绪'} · 已保存版本 {session.revision} / 已应用版本 {appliedRevision}</p>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="w-4 h-4" />{connections.length}</span><span>上限 {session.policy.max_viewers || '不限'}</span><span>{session.controller_connection_id ? '控制中' : '暂无控制者'}</span></div>
          </div>
          <MediaRuntime observation={media.error ? undefined : currentMediaObservation(media.data, session, now)} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {connections.map((connection) => {
              const isController = connection.connection_id === session.controller_connection_id
              const expired = Date.parse(connection.expires_at) <= now
              return <div key={connection.connection_id} className="client-card space-y-3" data-controller={isController}>
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-card-foreground">客户端 {connection.connection_id.slice(0, 6).toUpperCase()}</div><div className="text-[11px] text-muted-foreground font-mono truncate" title={connection.connection_id}>{connection.connection_id}</div></div>{isController && <Crown className="w-4 h-4 text-primary shrink-0" />}</div>
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
          <AudioSettings session={session} busy={busy} action={action} />
          <AudioTargetSettings session={session} busy={busy} action={action} />
        </Card>
      })}
      {sessions.length === 0 && <div className="text-center text-muted-foreground py-12">当前没有渲染会话</div>}
    </div>
  </QueryWrapper>
}
