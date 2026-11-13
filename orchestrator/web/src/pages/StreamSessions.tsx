import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { currentMediaObservation, overviewServerTime, type MediaObservation, type RenderSession } from '@/api/sessions'
import { useQuery } from '@/hooks/useQuery'
import { useConfigurationDraft } from '@/hooks/useConfigurationDraft'
import QueryWrapper from '@/components/QueryWrapper'
import { ContentGrid, EmptyState, Metric, Page } from '@/components/layout/Page'
import StatusBadge from '@/components/StatusBadge'
import { Link, useSearchParams } from 'react-router'
import { Select } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatTime } from '@/lib/utils'
import { findSessionApplication, isLiveConnection, sessionOverview, type SessionApplication } from '@/lib/session-overview'
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
    device_open: '目标音频输出端已打开，程序录音待确认',
    device_failed: '目标音频输出端故障',
    remote_transport: '远端麦克风传输已连接 · 录音效果请在目标程序确认',
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
  const audioDraft = useConfigurationDraft(session.audio, (a, b) => a.program_gain_db === b.program_gain_db && a.microphone_gain_db === b.microphone_gain_db && a.microphone_enabled === b.microphone_enabled && a.broadcast_controller_microphone === b.broadcast_controller_microphone && a.controller_monitor === b.controller_monitor)
  const {value: audio, baseline, dirty, stale, edit: setAudio} = audioDraft
  const policyDraft = useConfigurationDraft(session.policy, (a, b) => a.max_viewers === b.max_viewers && a.controller_disconnect_policy === b.controller_disconnect_policy && a.allow_viewer_microphone === b.allow_viewer_microphone)
  const capacity = policyDraft.value.max_viewers
  const setCapacity = (max_viewers: number) => policyDraft.edit({...policyDraft.value, max_viewers})
  return <ContentGrid variant="fields" className="border-t border-border mt-4 pt-4">
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (stale) return; void action(async () => {
      const result = await api.updateStreamAudio(session.session_id, audio, baseline)
      if (result.data) audioDraft.reset()
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
          {(dirty || stale) && <Button size="sm" type="button" variant="outline" onClick={audioDraft.reset}>载入最新音频配置</Button>}
        </div>
      </fieldset>
    </form>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (policyDraft.stale) return; void action(async () => {
      const result = await api.updateStreamPolicy(session.session_id, policyDraft.value, policyDraft.baseline)
      if (result.data) policyDraft.reset()
      return result
    }) }}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="font-medium mb-2">连接容量</legend>
        <label className="flex items-center gap-2 text-sm">最大客户端数<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={0} step={1} value={capacity} onChange={(e) => setCapacity(e.target.valueAsNumber)} /></label>
        <p className="text-xs text-muted-foreground">0 表示不限制。降低上限后，已有连接保留，新连接按新上限准入。</p>
        <p className="text-xs text-muted-foreground">控制者连接租约到期后释放控制权；恢复连接后作为观众，由管理员重新授权。观众不能发送麦克风或控制输入。</p>
        {policyDraft.stale && <p role="alert" className="text-sm text-amber-400">连接配置已更新，当前容量草稿已保留。请载入最新配置后重新编辑。</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={policyDraft.stale}>应用连接容量</Button>
          {(policyDraft.dirty || policyDraft.stale) && <Button size="sm" type="button" variant="outline" onClick={policyDraft.reset}>载入最新连接配置</Button>}
        </div>
      </fieldset>
    </form>
  </ContentGrid>
}

const HISTORY_PAGE_SIZE = 10

export default function StreamSessions() {
  const [, tick] = useState(0)
  useEffect(() => {
    // Expire displayed evidence even while a poll is stalled or offline.
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { data: snapshot, loading, error, refresh } = useQuery({
    queryKey: managementKeys.overview,
    queryFn: useCallback((signal: AbortSignal) => api.getStreamSessionOverview(signal), []),
    pollInterval: 2000,
    wsInvalidateEvents: ['stream_session_created', 'stream_session_state_changed', 'stream_connection_changed', 'stream_connection_expired', 'stream_connection_resumed', 'stream_controller_changed', 'stream_audio_changed', 'stream_policy_changed'],
  })
  const apps = useQuery<SessionApplication[]>({ queryKey: managementKeys.apps, queryFn: useCallback((signal: AbortSignal) => api.listApps(signal), []), pollInterval: 10000, wsInvalidateEvents: ['app_status'] })
  const data = snapshot?.sessions
  const media = snapshot?.media
  const now = snapshot ? overviewServerTime(snapshot) : Date.now()
  const [search, setSearch] = useSearchParams()
  const selectedApp = search.get('app') ?? ''
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [notice, setNotice] = useState('')
  const [commandError, setCommandError] = useState('')
  const [view, setView] = useState<'current' | 'history'>('current')
  const [historyPage, setHistoryPage] = useState(1)
  const visibleSessions = selectedApp ? (data ?? []).filter(session => findSessionApplication(apps.data ?? [], session)?.id === selectedApp) : data ?? []
  const overview = sessionOverview(visibleSessions, now)
  const pageCount = Math.max(1, Math.ceil(overview.history.length / HISTORY_PAGE_SIZE))
  const page = Math.min(historyPage, pageCount)
  const appFor = (session: RenderSession) => findSessionApplication(apps.data ?? [], session)
  const action: Action = async (operation) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice('')
    setCommandError('')
    try { await operation(); setNotice('操作已提交，状态以服务器最新反馈为准。') }
    catch (e: unknown) { setCommandError(e instanceof Error ? e.message : '操作失败') }
    finally { try { await Promise.all([refresh(), apps.refresh()]) } finally { inFlight.current = false; setBusy(false) } }
  }

  return <Page title="串流会话" eyebrow="连接与协作" description="按应用管理观看连接、唯一控制权和实时音频。" actions={
    <Button variant="outline" onClick={() => { void refresh(); void apps.refresh() }} disabled={busy}><RefreshCw className="w-4 h-4" />刷新</Button>
  }>
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <ContentGrid variant="metrics">
        <Metric label="当前会话" value={overview.current.length} />
        <Metric label="在线客户端" value={overview.clients} />
        <Metric label="在线控制者" value={overview.controllers} />
      </ContentGrid>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground" htmlFor="session-app">查看应用
          <Select id="session-app" value={selectedApp} onChange={event => { const next = new URLSearchParams(search); if (event.target.value) next.set('app', event.target.value); else next.delete('app'); setSearch(next); setHistoryPage(1) }}>
            <option value="">全部应用</option>
            {selectedApp && !apps.data?.some(app => app.id === selectedApp) && <option value={selectedApp}>正在确认应用…</option>}
            {apps.data?.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </Select>
        </label>
        <Link className="inline-flex min-h-10 items-center text-sm text-primary hover:underline" to={selectedApp ? `/apps/${selectedApp}` : '/apps'}>{selectedApp ? '应用配置与观看链接 ↗' : '应用管理 ↗'}</Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex gap-2" aria-label="会话视图">
          <Button variant={view === 'current' ? 'primary' : 'outline'} aria-pressed={view === 'current'} onClick={() => setView('current')}>当前会话 ({overview.current.length})</Button>
          <Button variant={view === 'history' ? 'primary' : 'outline'} aria-pressed={view === 'history'} onClick={() => setView('history')}>已结束记录 ({overview.history.length})</Button>
        </div>
        <Link className="text-sm text-primary hover:underline" to="/apps">前往应用管理</Link>
      </div>
      {notice && <p role="status" className="rounded-lg bg-primary/10 px-4 py-3 text-sm text-primary">{notice}</p>}
      {commandError && <p role="alert" className="text-sm text-red-400">{commandError}</p>}
      {apps.error && <p role="status" className="text-sm text-amber-400">应用名称和运行状态暂时无法更新，连接列表仍按会话数据显示。</p>}
      {view === 'history' ? <Card>
        <div className="mb-4"><h3 className="font-semibold">已结束的应用串流</h3><p className="mt-1 text-sm text-muted-foreground">仅保留最近 7 天、最多 100 条已结束记录。连接和控制权已释放，历史配置不再生效。</p></div>
        <div className="table-scroll" role="region" aria-label="已结束的应用串流" tabIndex={0}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground"><tr className="border-b border-border"><th className="py-3 pr-4">应用 / 会话</th><th className="py-3 pr-4">创建时间</th><th className="py-3 pr-4">最后更新</th><th className="py-3">状态</th></tr></thead>
            <tbody>{overview.history.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE).map(session => {
              const app = appFor(session)
              return <tr className="border-b border-border last:border-0" key={session.session_id}>
                <td className="py-3 pr-4"><div className="font-medium">{app?.name ?? `应用 ${session.app_id}`}</div><div className="mt-1 text-xs text-muted-foreground" title={session.session_id}>会话 {session.session_id.slice(0, 8)} · 主机 {session.host_id}</div></td>
                <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">{formatTime(session.created_at)}</td>
                <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">{formatTime(session.updated_at)}</td>
                <td className="py-3"><Badge variant="muted">已结束</Badge></td>
              </tr>
            })}</tbody>
          </table>
        </div>
        {overview.history.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">暂无已结束记录</p> : <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>共 {overview.history.length} 条 · 第 {page} / {pageCount} 页</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setHistoryPage(page - 1)}>上一页</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setHistoryPage(page + 1)}>下一页</Button></div></div>}
      </Card> : <>
        {media && !media.reachable && <p role="status" className="text-sm text-amber-400">媒体网关同步异常，正在重试。下方运行状态以最新反馈为准。</p>}
        {overview.current.map((session) => {
          const app = appFor(session)
          const connections = Object.values(session.connections).sort((a, b) => {
            const priority = (connection: typeof a) => isLiveConnection(connection, now) ? connection.connection_id === session.controller_connection_id ? 0 : 1 : 2
            return priority(a) - priority(b) || Date.parse(a.connected_at) - Date.parse(b.connected_at)
          })
          const online = connections.filter(connection => isLiveConnection(connection, now))
          const controller = online.find(connection => connection.connection_id === session.controller_connection_id)
          const observation = error ? undefined : currentMediaObservation(media, session, now)
          const appliedRevision = media?.applied_revisions[session.session_id] ?? 0
          const leaseValid = !error && media?.lease_valid && media.lease_expires_at_ms > now
          const applied = leaseValid && appliedRevision === session.revision
          const stopping = session.state === 'stopping'
          const pendingAdmission = session.state === 'starting' && Date.parse(session.admission_until ?? '') > now
          const inactive = !pendingAdmission && !apps.error && app?.status === 'stopped' && observation != null && !observation.upstream_active && online.length === 0
          return <Card key={session.session_id}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4 mb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold text-card-foreground">{app ? <Link to={`/apps/${app.id}`} className="hover:text-primary">{app.name}</Link> : `应用 ${session.app_id}`}</h3>
                  <Badge variant={stopping ? 'warning' : observation?.upstream_active ? 'success' : 'muted'}>{stopping ? '正在结束' : inactive ? '已停止 · 待结束' : observation?.upstream_active ? '正在串流' : pendingAdmission ? online.length ? '正在建立串流' : '等待客户端接入' : observation ? '等待串流' : '串流状态待确认'}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>应用状态</span>{app && !apps.error ? <StatusBadge status={app.status} /> : <span>待确认</span>}<span title={session.session_id}>会话 {session.session_id.slice(0, 8)}</span><span>创建于 {formatTime(session.created_at)}</span></div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="w-4 h-4" />{online.length} 在线</span><span>上限 {session.policy.max_viewers || '不限'}</span><span>{controller ? '已分配控制权' : '暂无在线控制者'}</span></div>
            </div>
            {inactive ? <div className="rounded-lg bg-muted/30 p-4 text-sm">
              <p className="font-medium">应用已停止，当前没有观看连接</p>
              <p className="mt-1 text-muted-foreground">这是尚未结束的旧会话，音频和控制设置不再适用。</p>
              {app.lifecycle?.can_stop && <Link className="mt-3 inline-flex min-h-9 items-center text-primary hover:underline" to={`/apps/${app.id}`}>前往应用管理结束会话 →</Link>}
            </div> : <>
            <section aria-label="客户端与控制权">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">客户端与控制权</h4><p className="text-xs text-muted-foreground">同一时间仅一个客户端可操作应用、发送麦克风</p></div>
              <ContentGrid>
                {connections.map((connection) => {
                  const live = isLiveConnection(connection, now)
                  const isController = connection.connection_id === session.controller_connection_id && live
                  return <div key={connection.connection_id} className="client-card space-y-3" data-controller={isController}>
                    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-card-foreground">{connection.client_type === 'android' ? 'Android' : connection.client_type === 'web' ? 'Web' : '客户端'} {connection.connection_id.slice(0, 6).toUpperCase()}</div><div className="mt-1 text-xs text-muted-foreground">接入 {formatTime(connection.connected_at)}</div></div>{isController && <Badge variant="info"><Crown className="h-3 w-3" />唯一控制者</Badge>}</div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{!live ? '连接已过期 · 等待清理' : isController ? '控制者 · 在线' : '观众 · 在线'}</span><span className="inline-flex items-center gap-1">{live && connection.microphone_live ? <Mic className="w-3 h-3 text-green-400" /> : <MicOff className="w-3 h-3" />}{live && connection.microphone_live ? '麦克风正在发送' : '麦克风关闭'}</span></div>
                    <div className="flex flex-wrap gap-2">
                      {isController
                        ? <Button size="sm" variant="outline" disabled={busy || stopping} onClick={() => void action(() => api.releaseStreamController(session.session_id))}><Unlock className="w-3 h-3" />释放控制权</Button>
                        : <Button size="sm" disabled={busy || !live || stopping} onClick={() => void action(() => api.transferStreamController(session.session_id, connection.connection_id, session.controller_connection_id ?? '', session.control_epoch))}><Crown className="w-3 h-3" />{controller ? '转移控制权' : '授予控制权'}</Button>}
                      <Button size="sm" variant="outline" disabled={busy || stopping} onClick={() => void action(() => api.disconnectStreamConnection(session.session_id, connection.connection_id))}><UserX className="w-3 h-3" />断开</Button>
                    </div>
                  </div>
                })}
              </ContentGrid>
              {connections.length === 0 && <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">暂无客户端连接。客户端通过应用的永久观看链接接入后，会显示在这里。</div>}
            </section>
            <div className="mt-5 rounded-lg border border-border bg-muted/20 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">音频路由</h4><span className="text-xs text-muted-foreground">唯一控制者 → 目标程序 / 观看端</span></div>
              <ContentGrid variant="fields" className="text-xs">
                <div><p className="text-muted-foreground">目标程序接收语音</p><p className="mt-1 font-medium">{!session.audio.microphone_enabled || session.audio.target.mode === 'disabled' ? '已关闭' : ({local:'服务器录音设备', remote:'远程渲染节点', upstream:'原生音频通道'} as Record<string,string>)[session.audio.target.mode]}</p></div>
                <div><p className="text-muted-foreground">观看端接收声音</p><p className="mt-1 font-medium">{session.audio.microphone_enabled && session.audio.broadcast_controller_microphone ? '程序声音 + 控制者麦克风' : '程序声音'}</p></div>
                <div><p className="text-muted-foreground">当前麦克风</p><p className="mt-1 font-medium">{controller?.microphone_live ? '控制者正在发送' : controller ? '控制者未开启' : '等待分配控制权'}</p></div>
              </ContentGrid>
            </div>
            <details className="mt-4 border-t border-border pt-4">
              <summary className="cursor-pointer text-sm font-medium">音频与连接设置 <span className="ml-2 text-xs font-normal text-muted-foreground">当前会话 · 保存后实时应用</span></summary>
              <fieldset disabled={stopping}>
                <AudioSettings session={session} busy={busy || stopping} action={action} />
                <AudioTargetSettings session={session} busy={busy || stopping} action={action} />
              </fieldset>
            </details>
            <details className="mt-4 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer font-medium">媒体与设备状态 <span className={`ml-2 text-xs font-normal ${applied ? 'text-green-400' : 'text-amber-400'}`}>{applied ? '会话状态已同步' : leaseValid ? '等待网关同步' : '网关未就绪'}</span></summary>
              <div className="mt-3"><MediaRuntime observation={observation} /></div>
              <p className="mt-3 break-all text-xs text-muted-foreground">主机 {session.host_id} · 应用 {session.app_id} · 会话 {session.session_id}</p>
              <p className="mt-1 text-xs text-muted-foreground">会话版本 {session.revision} / 网关确认版本 {appliedRevision} · 会话状态 {session.state}</p>
            </details>
            </>}
          </Card>
        })}
        {overview.current.length === 0 && <EmptyState title={selectedApp ? '此应用当前没有串流会话' : '当前没有串流会话'} description="从应用管理启动串流，或使用应用的永久观看链接接入。" />}
      </>}
      <details className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">会话和客户端有什么区别？</summary>
        <div className="space-y-2 pt-3 leading-relaxed">
          <p>一个应用的一次串流由多个客户端共享。同一会话可以暂时无人观看；停止应用后，该会话结束，下次启动创建新会话。</p>
          <p>客户端记录代表一次连接，不是永久设备档案。短暂断线可恢复；一周后重新访问会创建新的连接，控制权由管理员重新分配。</p>
          <p>已结束记录仅供查阅历史状态，不代表在线设备，也不占用观看名额。永久观看链接属于应用，不会因会话结束而失效。</p>
        </div>
      </details>
    </QueryWrapper>
  </Page>
}
