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
import { useManagementLocale } from '@/i18n'

type Action = (operation: () => Promise<unknown>) => Promise<void>

function MediaRuntime({ observation }: { observation?: MediaObservation }) {
  const { t } = useManagementLocale()
  if (!observation) return <p role="status" className="text-sm text-amber-400 mb-4">{t('sessions.mediaUnknown')}</p>
  const target = observation.microphone_target
  const labels: Record<MediaObservation['microphone_target']['state'], string> = {
    unconfigured: t('sessions.audio.unconfigured'), idle: t('sessions.audio.idle'), pending: t('sessions.audio.pending'), disabled: t('sessions.audio.disabled'), device_open: t('sessions.audio.deviceOpen'), device_failed: t('sessions.audio.deviceFailed'), remote_transport: t('sessions.audio.remoteTransport'), upstream_transport: t('sessions.audio.upstreamTransport'),
  }
  return <div role="status" className="runtime-strip">
    <p>{observation.upstream_active ? t('sessions.sharedUpstreamRunning') : t('sessions.sharedUpstreamStopped')} · {t('sessions.subscribers')} {observation.subscribers}</p>
    <p className={target.state === 'device_failed' || target.state === 'unconfigured' ? 'text-amber-400' : ''}>{labels[target.state]}</p>
    {target.device && <details><summary>{t('sessions.audioDeviceDetails')}</summary><p className="mt-2">{t('sessions.processedFrames')} {target.device.device_sample_frames} · {t('sessions.droppedFrames')} {target.device.dropped_frames} · {t('sessions.xruns')} {target.device.xruns}</p></details>}
    {target.device?.realtime_denied && <p className="text-xs text-amber-400">{t('sessions.realtimeDenied')}</p>}
    {target.device?.error && <p className="text-xs text-red-400">{target.device.error}</p>}
    {target.error && <p className="text-xs text-red-400">{target.error}</p>}
    <p className="text-xs text-muted-foreground">{t('sessions.microphoneInputHint')}</p>
  </div>
}

function AudioSettings({ session, busy, action }: { session: RenderSession; busy: boolean; action: Action }) {
  const { t } = useManagementLocale()
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
        <legend className="font-medium mb-2">{t('sessions.audioSettings')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={audio.microphone_enabled} onChange={(e) => setAudio({ ...audio, microphone_enabled: e.target.checked })} />{t('sessions.allowControllerMic')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={audio.broadcast_controller_microphone} onChange={(e) => setAudio({ ...audio, broadcast_controller_microphone: e.target.checked })} />{t('sessions.broadcastControllerMic')}</label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">{t('sessions.programGain')}<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={-60} max={12} step={1} value={audio.program_gain_db} onChange={(e) => setAudio({ ...audio, program_gain_db: e.target.valueAsNumber })} /></label>
          <label className="flex items-center gap-2">{t('sessions.microphoneGain')}<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={-60} max={12} step={1} value={audio.microphone_gain_db} onChange={(e) => setAudio({ ...audio, microphone_gain_db: e.target.valueAsNumber })} /></label>
        </div>
        {stale && <p role="alert" className="text-sm text-amber-400">{t('sessions.audioStale')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={stale}>{t('sessions.applyAudio')}</Button>
          {(dirty || stale) && <Button size="sm" type="button" variant="outline" onClick={audioDraft.reset}>{t('sessions.reloadAudio')}</Button>}
        </div>
      </fieldset>
    </form>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (policyDraft.stale) return; void action(async () => {
      const result = await api.updateStreamPolicy(session.session_id, policyDraft.value, policyDraft.baseline)
      if (result.data) policyDraft.reset()
      return result
    }) }}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="font-medium mb-2">{t('sessions.connectionCapacity')}</legend>
        <label className="flex items-center gap-2 text-sm">{t('sessions.maxClients')}<input className="w-20 rounded border border-border bg-background px-2 py-1" type="number" required min={0} step={1} value={capacity} onChange={(e) => setCapacity(e.target.valueAsNumber)} /></label>
        <p className="text-xs text-muted-foreground">{t('sessions.capacityHint')}</p>
        <p className="text-xs text-muted-foreground">{t('sessions.controlLeaseHint')}</p>
        {policyDraft.stale && <p role="alert" className="text-sm text-amber-400">{t('sessions.policyStale')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={policyDraft.stale}>{t('sessions.applyCapacity')}</Button>
          {(policyDraft.dirty || policyDraft.stale) && <Button size="sm" type="button" variant="outline" onClick={policyDraft.reset}>{t('sessions.reloadCapacity')}</Button>}
        </div>
      </fieldset>
    </form>
  </ContentGrid>
}

const HISTORY_PAGE_SIZE = 10

export default function StreamSessions() {
  const { t } = useManagementLocale()
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
    try { await operation(); setNotice(t('sessions.commandSubmitted')) }
    catch (e: unknown) { setCommandError(e instanceof Error ? e.message : t('sessions.commandFailed')) }
    finally { try { await Promise.all([refresh(), apps.refresh()]) } finally { inFlight.current = false; setBusy(false) } }
  }

  return <Page title={t('sessions.title')} eyebrow={t('sessions.eyebrow')} description={t('sessions.description')} actions={
    <Button variant="outline" onClick={() => { void refresh(); void apps.refresh() }} disabled={busy}><RefreshCw className="w-4 h-4" />{t('common.refresh')}</Button>
  }>
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <ContentGrid variant="metrics">
        <Metric label={t('sessions.current')} value={overview.current.length} description={t('sessions.currentHelp')} />
        <Metric label={t('sessions.onlineClients')} value={overview.clients} description={t('sessions.onlineClientsHelp')} />
        <Metric label={t('sessions.onlineControllers')} value={overview.controllers} description={t('sessions.onlineControllersHelp')} />
      </ContentGrid>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground" htmlFor="session-app">{t('sessions.viewApp')}
          <Select id="session-app" value={selectedApp} onChange={event => { const next = new URLSearchParams(search); if (event.target.value) next.set('app', event.target.value); else next.delete('app'); setSearch(next); setHistoryPage(1) }}>
            <option value="">{t('sessions.allApps')}</option>
            {selectedApp && !apps.data?.some(app => app.id === selectedApp) && <option value={selectedApp}>{t('sessions.confirmingApp')}</option>}
            {apps.data?.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </Select>
        </label>
        <Link className="inline-flex min-h-10 items-center text-sm text-primary hover:underline" to={selectedApp ? `/apps/${selectedApp}` : '/apps'}>{selectedApp ? t('sessions.appConfigLink') : t('sessions.appsLink')} ↗</Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex gap-2" aria-label={t('sessions.viewLabel')}>
          <Button variant={view === 'current' ? 'primary' : 'outline'} aria-pressed={view === 'current'} onClick={() => setView('current')}>{t('sessions.currentSessions')} ({overview.current.length})</Button>
          <Button variant={view === 'history' ? 'primary' : 'outline'} aria-pressed={view === 'history'} onClick={() => setView('history')}>{t('sessions.history')} ({overview.history.length})</Button>
        </div>
        <Link className="text-sm text-primary hover:underline" to="/apps">{t('sessions.goApps')}</Link>
      </div>
      {notice && <p role="status" className="rounded-lg bg-primary/10 px-4 py-3 text-sm text-primary">{notice}</p>}
      {commandError && <p role="alert" className="text-sm text-red-400">{commandError}</p>}
      {apps.error && <p role="status" className="text-sm text-amber-400">{t('sessions.appsUnavailable')}</p>}
      {view === 'history' ? <Card>
        <div className="mb-4"><h3 className="font-semibold">{t('sessions.endedStreams')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('sessions.historyHint')}</p></div>
        <div className="table-scroll" role="region" aria-label={t('sessions.endedStreams')} tabIndex={0}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground"><tr className="border-b border-border"><th className="py-3 pr-4">{t('sessions.appSession')}</th><th className="py-3 pr-4">{t('sessions.createdAt')}</th><th className="py-3 pr-4">{t('sessions.updatedAt')}</th><th className="py-3">{t('appDetail.status')}</th></tr></thead>
            <tbody>{overview.history.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE).map(session => {
              const app = appFor(session)
              return <tr className="border-b border-border last:border-0" key={session.session_id}>
                <td className="py-3 pr-4"><div className="font-medium">{app?.name ?? `${t('sessions.app')} ${session.app_id}`}</div><div className="mt-1 text-xs text-muted-foreground" title={session.session_id}>{t('sessions.session')} {session.session_id.slice(0, 8)} · {t('sessions.host')} {session.host_id}</div></td>
                <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">{formatTime(session.created_at)}</td>
                <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">{formatTime(session.updated_at)}</td>
                <td className="py-3"><Badge variant="muted">{t('sessions.ended')}</Badge></td>
              </tr>
            })}</tbody>
          </table>
        </div>
        {overview.history.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t('sessions.noHistory')}</p> : <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('sessions.total')} {overview.history.length} · {t('sessions.page')} {page} / {pageCount}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setHistoryPage(page - 1)}>{t('sessions.previous')}</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setHistoryPage(page + 1)}>{t('sessions.next')}</Button></div></div>}
      </Card> : <>
      {media && !media.reachable && <p role="status" className="text-sm text-amber-400">{t('sessions.gatewaySyncFailed')}</p>}
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
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold text-card-foreground">{app ? <Link to={`/apps/${app.id}`} className="hover:text-primary">{app.name}</Link> : `${t('sessions.app')} ${session.app_id}`}</h3>
                  <Badge variant={stopping ? 'warning' : observation?.upstream_active ? 'success' : 'muted'}>{stopping ? t('sessions.stopping') : inactive ? t('sessions.stoppedPending') : observation?.upstream_active ? t('sessions.streaming') : pendingAdmission ? online.length ? t('sessions.buildingStream') : t('sessions.waitingClient') : observation ? t('sessions.waitingStream') : t('sessions.statusUnconfirmed')}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t('sessions.appStatus')}</span>{app && !apps.error ? <StatusBadge status={app.status} /> : <span>{t('sessions.pendingConfirmation')}</span>}<span title={session.session_id}>{t('sessions.session')} {session.session_id.slice(0, 8)}</span><span>{t('sessions.createdAt')} {formatTime(session.created_at)}</span></div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="w-4 h-4" />{online.length} {t('sessions.online')}</span><span>{t('sessions.limit')} {session.policy.max_viewers || t('sessions.unlimited')}</span><span>{controller ? t('sessions.controllerAssigned') : t('sessions.noController')}</span></div>
            </div>
            {inactive ? <div className="rounded-lg bg-muted/30 p-4 text-sm">
              <p className="font-medium">{t('sessions.appStoppedNoViewers')}</p>
              <p className="mt-1 text-muted-foreground">{t('sessions.oldSessionHint')}</p>
              {app.lifecycle?.can_stop && <Link className="mt-3 inline-flex min-h-9 items-center text-primary hover:underline" to={`/apps/${app.id}`}>{t('sessions.finishInApps')} →</Link>}
            </div> : <>
            <section aria-label={t('sessions.clientsAndControl')}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{t('sessions.clientsAndControl')}</h4><p className="text-xs text-muted-foreground">{t('sessions.singleControllerHint')}</p></div>
              <ContentGrid>
                {connections.map((connection) => {
                  const live = isLiveConnection(connection, now)
                  const isController = connection.connection_id === session.controller_connection_id && live
                  return <div key={connection.connection_id} className="client-card space-y-3" data-controller={isController}>
                    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-card-foreground">{connection.client_type === 'android' ? 'Android' : connection.client_type === 'web' ? 'Web' : t('sessions.client')} {connection.connection_id.slice(0, 6).toUpperCase()}</div><div className="mt-1 text-xs text-muted-foreground">{t('sessions.connectedAt')} {formatTime(connection.connected_at)}</div></div>{isController && <Badge variant="info"><Crown className="h-3 w-3" />{t('sessions.uniqueController')}</Badge>}</div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{!live ? t('sessions.expired') : isController ? t('sessions.controllerOnline') : t('sessions.viewerOnline')}</span><span className="inline-flex items-center gap-1">{live && connection.microphone_live ? <Mic className="w-3 h-3 text-green-400" /> : <MicOff className="w-3 h-3" />}{live && connection.microphone_live ? t('sessions.micSending') : t('sessions.micOff')}</span></div>
                    <div className="flex flex-wrap gap-2">
                      {isController
                        ? <Button size="sm" variant="outline" disabled={busy || stopping} onClick={() => void action(() => api.releaseStreamController(session.session_id))}><Unlock className="w-3 h-3" />{t('sessions.releaseControl')}</Button>
                        : <Button size="sm" disabled={busy || !live || stopping} onClick={() => void action(() => api.transferStreamController(session.session_id, connection.connection_id, session.controller_connection_id ?? '', session.control_epoch))}><Crown className="w-3 h-3" />{controller ? t('sessions.transferControl') : t('sessions.grantControl')}</Button>}
                      <Button size="sm" variant="outline" disabled={busy || stopping} onClick={() => void action(() => api.disconnectStreamConnection(session.session_id, connection.connection_id))}><UserX className="w-3 h-3" />{t('sessions.disconnect')}</Button>
                    </div>
                  </div>
                })}
              </ContentGrid>
              {connections.length === 0 && <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">{t('sessions.noClients')}</div>}
            </section>
            <div className="mt-5 rounded-lg border border-border bg-muted/20 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{t('sessions.audioRouting')}</h4><span className="text-xs text-muted-foreground">{t('sessions.audioRoutingHint')}</span></div>
              <ContentGrid variant="fields" className="text-xs">
                <div><p className="text-muted-foreground">{t('sessions.programReceivesMic')}</p><p className="mt-1 font-medium">{!session.audio.microphone_enabled || session.audio.target.mode === 'disabled' ? t('sessions.disabled') : ({local:t('sessions.localAudioDevice'), remote:t('sessions.remoteRenderNode'), upstream:t('sessions.nativeAudioChannel')} as Record<string,string>)[session.audio.target.mode]}</p></div>
                <div><p className="text-muted-foreground">{t('sessions.viewerReceivesAudio')}</p><p className="mt-1 font-medium">{session.audio.microphone_enabled && session.audio.broadcast_controller_microphone ? t('sessions.programAndControllerMic') : t('sessions.programAudio')}</p></div>
                <div><p className="text-muted-foreground">{t('sessions.currentMic')}</p><p className="mt-1 font-medium">{controller?.microphone_live ? t('sessions.controllerSending') : controller ? t('sessions.controllerMicOff') : t('sessions.waitingController')}</p></div>
              </ContentGrid>
            </div>
            <details className="mt-4 border-t border-border pt-4">
              <summary className="cursor-pointer text-sm font-medium">{t('sessions.audioConnectionSettings')} <span className="ml-2 text-xs font-normal text-muted-foreground">{t('sessions.appliesImmediately')}</span></summary>
              <fieldset disabled={stopping}>
                <AudioSettings session={session} busy={busy || stopping} action={action} />
                <AudioTargetSettings session={session} busy={busy || stopping} action={action} />
              </fieldset>
            </details>
            <details className="mt-4 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer font-medium">{t('sessions.mediaDeviceStatus')} <span className={`ml-2 text-xs font-normal ${applied ? 'text-green-400' : 'text-amber-400'}`}>{applied ? t('sessions.sessionSynced') : leaseValid ? t('sessions.waitingGateway') : t('sessions.gatewayNotReady')}</span></summary>
              <div className="mt-3"><MediaRuntime observation={observation} /></div>
              <p className="mt-3 break-all text-xs text-muted-foreground">{t('sessions.host')} {session.host_id} · {t('sessions.app')} {session.app_id} · {t('sessions.session')} {session.session_id}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('sessions.sessionRevision')} {session.revision} / {t('sessions.gatewayRevision')} {appliedRevision} · {t('sessions.sessionState')} {session.state}</p>
            </details>
            </>}
          </Card>
        })}
        {overview.current.length === 0 && <EmptyState title={selectedApp ? t('sessions.noSelectedAppSessions') : t('sessions.noSessions')} description={t('sessions.noSessionsDescription')} />}
      </>}
      <details className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">{t('sessions.explainerTitle')}</summary>
        <div className="space-y-2 pt-3 leading-relaxed">
          <p>{t('sessions.explainerSession')}</p>
          <p>{t('sessions.explainerConnection')}</p>
          <p>{t('sessions.explainerHistory')}</p>
        </div>
      </details>
    </QueryWrapper>
  </Page>
}
