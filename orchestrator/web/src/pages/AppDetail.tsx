import { useCallback, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router'
import { useAppCommand, type AppCommand } from '@/hooks/useAppCommand'
import { useQuery } from '@/hooks/useQuery'
import { useConfigurationDraft } from '@/hooks/useConfigurationDraft'
import { ContentGrid, Page } from '@/components/layout/Page'
import QueryWrapper from '@/components/QueryWrapper'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { openViewingStream } from '@/lib/stream-access'
import AppWatchLink from '@/components/AppWatchLink'
import StatusBadge from '@/components/StatusBadge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button, LinkButton } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'
import { formatBytes, formatTime, argsToLines, linesToArgs } from '@/lib/utils'
import { ArrowLeft, Trash2, Save, RotateCcw, Play, Square, Users, ArrowUpRight } from 'lucide-react'
import CaptureModeField, { type CaptureMode } from '@/components/CaptureModeField'
import { useManagementLocale } from '@/i18n'

export default function AppDetail() {
  const { id } = useParams<{ id: string }>()
  return <AppDetailContent key={id} id={id} />
}

function AppDetailContent({id}: {id: string | undefined}) {
  const { t } = useManagementLocale()
  const navigate = useNavigate()
  const {data:app, error:loadError, refresh} = useQuery({
    queryKey: managementKeys.app(id),
    queryFn: useCallback((signal: AbortSignal) => api.getApp(id!, signal), [id]), enabled: !!id, pollInterval: 5000,
    wsInvalidateEvents: ['app_status', 'stream_session_state_changed', 'stream_session_created'],
  })
  const settingsDraft = useConfigurationDraft<{args: string; captureMode: CaptureMode}>(
    { args: argsToLines(app?.args ?? ''), captureMode: app?.capture_mode ?? 'desktop' },
    (a, b) => a.args === b.args && a.captureMode === b.captureMode,
  )
  const {args, captureMode} = settingsDraft.value
  const argsDirty = settingsDraft.dirty
  const command = useAppCommand(refresh)
  const pending = id ? command.pending[id] : undefined
  const saving = pending === 'save'
  const retrying = pending === 'register'
  const launching = pending === 'launch'
  const stopping = pending === 'stop'
  const [saveNotice, setSaveNotice] = useState<{kind:'error'|'success';message:string}|null>(null)
  const candidatesQuery = useQuery({ queryKey: managementKeys.candidates(id), queryFn: useCallback((signal: AbortSignal) => api.getAppCandidates(id!, signal), [id]), enabled: !!id && app?.status === 'detecting', pollInterval: 5000 })
  const candidates = candidatesQuery.data ?? []
  const candidateError = app?.status === 'detecting' ? candidatesQuery.error : ''

  const execute = (kind: AppCommand, task: () => Promise<void>) => {
    if (!id || loadError) return
    return command.run(id, kind, async () => { setSaveNotice(null); await task() })
  }
  const handleSave = async () => {
    const confirmed = await execute('save', async () => { await api.updateApp(id!, {args:linesToArgs(args), capture_mode:captureMode}) })
    if (confirmed) {
      settingsDraft.reset()
      setSaveNotice({kind:'success',message:t('appDetail.savedNotice')})
    }
  }
  const handleDelete = () => {
    if (!app || !confirm(app.source === 'local' ? `${t('appDetail.removeConfirmLocalPrefix')} "${app.name}"${t('appDetail.removeConfirmLocalSuffix')}` : `${t('appDetail.deleteConfirmPrefix')} "${app.name}"${t('appDetail.deleteConfirmSuffix')}`)) return
    return execute('delete', async () => { await api.deleteApp(id!); navigate('/apps') })
  }
  const handleSelectExe = (exePath: string) => execute('select', async () => { await api.selectExe(id!, exePath) })
  const handleRetryRegister = () => execute('register', async () => { await api.retryRegister(id!) })
  const handleLaunch = () => execute('launch', async () => {
    await openViewingStream(async () => (await api.launchApp(id!)).data?.stream_url)
  })
  const handleStopStream = () => execute('stop', async () => { await api.stopApp(id!) })

  const back = <LinkButton to="/apps" variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" />{t('appDetail.back')}</LinkButton>
  if (!app) return <Page title={t('appDetail.title')} eyebrow={t('apps.eyebrow')} description={t('appDetail.description')} back={back}>
    <QueryWrapper loading={!loadError} error={loadError} onRetry={refresh}>{null}</QueryWrapper>
  </Page>

  const settingsEditable = app.lifecycle?.can_edit === true
  const settingsDisabled = !!pending || !!loadError || !settingsEditable

  return (
    <Page title={app.name} eyebrow={t('appDetail.eyebrow')} description={t('appDetail.description')} badge={<StatusBadge status={app.status} />} back={back}>
      {loadError && <Alert variant="warning" role="status">{t('appDetail.refreshFailed')}: {loadError}。{t('appDetail.showingLastState')}</Alert>}

      {command.error && <Alert variant="error" role="alert">{command.error}</Alert>}
      <ContentGrid variant="detail">
      <div className="page-stack">
      {/* Stream controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('appDetail.streamControl')}
            {app.status === 'running' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                {t('status.running')}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!['ready','stopped','crashed','running'].includes(app.status) && <p className="text-sm text-muted-foreground">
            {app.status==='register_failed'?t('appDetail.registerFirst'):t('appDetail.notReady')}
          </p>}
          <p className="mb-4 text-sm text-muted-foreground">{t('appDetail.streamDescription')}</p>
          <div className="flex flex-wrap items-center gap-3">
            {app.lifecycle?.can_launch && (
              <>
              <Button onClick={handleLaunch} disabled={!!pending || !!loadError}>
                <Play className="w-4 h-4" /> {launching ? t('appDetail.opening') : app.status === 'running' ? t('apps.enterStream') : t('apps.startStream')}
              </Button>
              </>
            )}
            {app.lifecycle?.can_stop && (
              <>
                <Button variant="destructive" onClick={handleStopStream} disabled={!!pending || !!loadError}>
                  <Square className="w-4 h-4" /> {stopping ? t('appDetail.stopping') : t('appDetail.stopWithProcess')}
                </Button>
              </>
            )}
            <Link to={`/stream-sessions?app=${encodeURIComponent(app.id)}`} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 text-sm hover:bg-accent"><Users className="h-4 w-4" />{t('appDetail.manageClients')}<ArrowUpRight className="h-3.5 w-3.5" /></Link>
          </div>
          <AppWatchLink appId={app.id} />
        </CardContent>
      </Card>

      {candidateError && <Alert variant="warning">{candidateError}</Alert>}
      {/* Exe selection dialog */}
      {app.status === 'detecting' && candidates.length > 0 && (
        <Alert variant="warning">
          <p className="font-medium mb-2">{t('appDetail.multipleExecutables')}</p>
          <div className="space-y-2">
            {candidates.map(c => (
              <Button
                key={c.relative_path}
                variant="outline"
                disabled={!!pending || !!loadError} onClick={() => handleSelectExe(c.relative_path)}
                className="w-full text-left justify-start"
              >
                {c.relative_path} <span className="text-muted-foreground">({formatBytes(c.size_bytes)})</span>
              </Button>
            ))}
          </div>
        </Alert>
      )}

      {/* Register failed retry */}
      {app.status === 'register_failed' && (
        <Alert variant="error">
          <p className="font-medium mb-1">{t('appDetail.registerFailedTitle')}</p>
          <p className="text-sm mb-2">{app.error_message}。{t('appDetail.registerFailedDescription')}</p>
          <Button size="sm" onClick={handleRetryRegister} disabled={retrying||saving}>
            <RotateCcw className="w-3 h-3" /> {retrying?t('appDetail.submitting'):t('appDetail.retryRegister')}
          </Button>
        </Alert>
      )}

      {/* Args editing */}
      <details open={settingsEditable || argsDirty} className="rounded-xl border border-border bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">{t('appDetail.captureAndLaunch')} <span className="ml-2 text-xs font-normal text-muted-foreground">{settingsEditable ? t('appDetail.appliesNextLaunch') : t('appDetail.editAfterStop')}</span></summary>
        <div className="mt-4 space-y-3">
          {!settingsEditable && <Alert variant="info" role="status">{app.status==='running'?t('appDetail.stopBeforeEdit'):t('appDetail.waitBeforeEdit')}</Alert>}
          <CaptureModeField value={captureMode} disabled={settingsDisabled} onChange={mode=>{settingsDraft.edit({...settingsDraft.value,captureMode:mode});setSaveNotice(null)}} />
          <label htmlFor="application-args" className="block text-sm font-medium">{t('appDetail.launchArgs')}</label>
          <p id="application-args-help" className="text-xs text-muted-foreground">{t('appDetail.launchArgsHelp')}</p>
          <Textarea
            id="application-args"
            aria-describedby="application-args-help"
            disabled={settingsDisabled}
            value={args}
            onChange={e => { settingsDraft.edit({...settingsDraft.value,args:e.target.value});setSaveNotice(null) }}
            rows={5}
            placeholder={t('appDetail.noLaunchArgs')}
            className="font-mono"
          />
          {saveNotice && <Alert variant={saveNotice.kind} role={saveNotice.kind==='error'?'alert':'status'}>{saveNotice.message}</Alert>}
          <div className="flex flex-wrap items-center gap-3"><Button
            onClick={handleSave}
            disabled={settingsDisabled || (linesToArgs(args) === (app.args || '') && captureMode===(app.capture_mode||'desktop'))}
            size="sm"
          >
            <Save className="w-3 h-3" /> {saving ? t('appDetail.saving') : t('appDetail.save')}
          </Button>{argsDirty && <><Button variant="outline" size="sm" disabled={!!pending} onClick={settingsDraft.reset}>{t('appDetail.reloadServerConfig')}</Button><span className="text-xs text-muted-foreground">{t('appDetail.draftNotice')}</span></>}</div>
        </div>
      </details>

      </div>
      <aside className="page-stack" aria-label={t('appDetail.infoAndMaintenance')}>
      {/* Info */}
      <details open className="panel">
        <summary className="cursor-pointer text-sm font-medium">{t('appDetail.info')}</summary>
        <div className="mt-4">
          <ContentGrid variant="fields" className="text-sm">
            <div>
              <span className="text-muted-foreground">{t('appDetail.entryFile')}：</span>
              <span className="break-all text-card-foreground">{app.source==='local'?app.exe_path:(app.exe_relative_path || '-')}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('appDetail.source')}：</span>
              <span className="text-card-foreground">{app.source==='local'?t('appDetail.localExternal'):t('appDetail.uploadedPackage')+` · ${formatBytes(app.extracted_size_bytes || app.file_size_bytes)}`}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('appDetail.addedAt')}：</span>
              <span className="text-card-foreground">{formatTime(app.created_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('appDetail.status')}：</span>
              <StatusBadge status={app.status} />
            </div>
          </ContentGrid>

        </div>
      </details>

      {/* Danger zone */}
      <details className="panel">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t('appDetail.remove')}</summary>
        <div className="mt-4"><p className="mb-3 text-xs text-muted-foreground">{app.source === 'local' ? t('appDetail.removeLocalDescription') : t('appDetail.removeUploadedDescription')}</p>
          <Button variant="destructive" size="sm" disabled={!!pending || !!loadError} onClick={handleDelete}>
            <Trash2 className="w-3 h-3" /> {app.source==='local'?t('appDetail.removeRegistration'):t('appDetail.deleteApp')}
          </Button>
        </div>
      </details>
      </aside>
      </ContentGrid>
    </Page>
  )
}
