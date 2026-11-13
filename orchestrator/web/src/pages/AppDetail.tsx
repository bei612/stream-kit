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

export default function AppDetail() {
  const { id } = useParams<{ id: string }>()
  return <AppDetailContent key={id} id={id} />
}

function AppDetailContent({id}: {id: string | undefined}) {
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
      setSaveNotice({kind:'success',message:'配置已保存，下次启动应用时生效。'})
    }
  }
  const handleDelete = () => {
    if (!app || !confirm(app.source === 'local' ? `移除 "${app.name}" 的平台注册？原程序及工作目录会保留。` : `确定删除应用 "${app.name}" 及上传文件？`)) return
    return execute('delete', async () => { await api.deleteApp(id!); navigate('/apps') })
  }
  const handleSelectExe = (exePath: string) => execute('select', async () => { await api.selectExe(id!, exePath) })
  const handleRetryRegister = () => execute('register', async () => { await api.retryRegister(id!) })
  const handleLaunch = () => execute('launch', async () => {
    await openViewingStream(async () => (await api.launchApp(id!)).data?.stream_url)
  })
  const handleStopStream = () => execute('stop', async () => { await api.stopApp(id!) })

  const back = <LinkButton to="/apps" variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" />返回应用列表</LinkButton>
  if (!app) return <Page title="应用详情" eyebrow="渲染内容" description="管理程序、启动配置和固定观看入口。" back={back}>
    <QueryWrapper loading={!loadError} error={loadError} onRetry={refresh}>{null}</QueryWrapper>
  </Page>

  const settingsEditable = app.lifecycle?.can_edit === true
  const settingsDisabled = !!pending || !!loadError || !settingsEditable

  return (
    <Page title={app.name} eyebrow="应用详情" description="管理程序、启动配置和固定观看入口。" badge={<StatusBadge status={app.status} />} back={back}>
      {loadError && <Alert variant="warning" role="status">状态刷新失败：{loadError}。当前显示上次读取的状态。</Alert>}

      {command.error && <Alert variant="error" role="alert">{command.error}</Alert>}
      <ContentGrid variant="detail">
      <div className="page-stack">
      {/* Stream controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            串流控制
            {app.status === 'running' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                运行中
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!['ready','stopped','crashed','running'].includes(app.status) && <p className="text-sm text-muted-foreground">
            {app.status==='register_failed'?'完成编码器注册后即可启动串流。':'应用尚未准备完成，请等待处理完成或按下方提示选择入口。'}
          </p>}
          <p className="mb-4 text-sm text-muted-foreground">启动应用并进入观看；连接后的控制权与麦克风路由在客户端页面管理。</p>
          <div className="flex flex-wrap items-center gap-3">
            {app.lifecycle?.can_launch && (
              <>
              <Button onClick={handleLaunch} disabled={!!pending || !!loadError}>
                <Play className="w-4 h-4" /> {launching ? '打开中...' : app.status === 'running' ? '进入串流' : '启动串流'}
              </Button>
              </>
            )}
            {app.lifecycle?.can_stop && (
              <>
                <Button variant="destructive" onClick={handleStopStream} disabled={!!pending || !!loadError}>
                  <Square className="w-4 h-4" /> {stopping ? '停止中...' : '停止串流（含程序）'}
                </Button>
              </>
            )}
            <Link to={`/stream-sessions?app=${encodeURIComponent(app.id)}`} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 text-sm hover:bg-accent"><Users className="h-4 w-4" />管理客户端与音频<ArrowUpRight className="h-3.5 w-3.5" /></Link>
          </div>
          <AppWatchLink appId={app.id} />
        </CardContent>
      </Card>

      {candidateError && <Alert variant="warning">{candidateError}</Alert>}
      {/* Exe selection dialog */}
      {app.status === 'detecting' && candidates.length > 0 && (
        <Alert variant="warning">
          <p className="font-medium mb-2">检测到多个可执行文件，请选择入口：</p>
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
          <p className="font-medium mb-1">配置尚未在编码器中应用成功</p>
          <p className="text-sm mb-2">{app.error_message}。检查编码器状态后，可重试已保存的配置。</p>
          <Button size="sm" onClick={handleRetryRegister} disabled={retrying||saving}>
            <RotateCcw className="w-3 h-3" /> {retrying?'正在提交…':'重试注册'}
          </Button>
        </Alert>
      )}

      {/* Args editing */}
      <details open={settingsEditable || argsDirty} className="rounded-xl border border-border bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">采集与启动配置 <span className="ml-2 text-xs font-normal text-muted-foreground">{settingsEditable ? '下次启动应用生效' : '停止串流后可修改'}</span></summary>
        <div className="mt-4 space-y-3">
          {!settingsEditable && <Alert variant="info" role="status">{app.status==='running'?'请先停止串流，再修改采集范围和启动参数。':'应用正在处理，请等待处理完成后修改配置。'}</Alert>}
          <CaptureModeField value={captureMode} disabled={settingsDisabled} onChange={mode=>{settingsDraft.edit({...settingsDraft.value,captureMode:mode});setSaveNotice(null)}} />
          <label htmlFor="application-args" className="block text-sm font-medium">启动参数</label>
          <p id="application-args-help" className="text-xs text-muted-foreground">每行一个参数，含空格的路径请用引号包裹</p>
          <Textarea
            id="application-args"
            aria-describedby="application-args-help"
            disabled={settingsDisabled}
            value={args}
            onChange={e => { settingsDraft.edit({...settingsDraft.value,args:e.target.value});setSaveNotice(null) }}
            rows={5}
            placeholder={"无启动参数"}
            className="font-mono"
          />
          {saveNotice && <Alert variant={saveNotice.kind} role={saveNotice.kind==='error'?'alert':'status'}>{saveNotice.message}</Alert>}
          <div className="flex flex-wrap items-center gap-3"><Button
            onClick={handleSave}
            disabled={settingsDisabled || (linesToArgs(args) === (app.args || '') && captureMode===(app.capture_mode||'desktop'))}
            size="sm"
          >
            <Save className="w-3 h-3" /> {saving ? '保存中...' : '保存'}
          </Button>{argsDirty && <><Button variant="outline" size="sm" disabled={!!pending} onClick={settingsDraft.reset}>载入服务器配置</Button><span className="text-xs text-muted-foreground">正在编辑 · 尚未确认应用</span></>}</div>
        </div>
      </details>

      </div>
      <aside className="page-stack" aria-label="程序信息和维护">
      {/* Info */}
      <details open className="panel">
        <summary className="cursor-pointer text-sm font-medium">程序信息与添加记录</summary>
        <div className="mt-4">
          <ContentGrid variant="fields" className="text-sm">
            <div>
              <span className="text-muted-foreground">入口文件：</span>
              <span className="break-all text-card-foreground">{app.source==='local'?app.exe_path:(app.exe_relative_path || '-')}</span>
            </div>
            <div>
              <span className="text-muted-foreground">来源：</span>
              <span className="text-card-foreground">{app.source==='local'?'本机程序（外部管理文件）':`上传包 · ${formatBytes(app.extracted_size_bytes || app.file_size_bytes)}`}</span>
            </div>
            <div>
              <span className="text-muted-foreground">添加时间：</span>
              <span className="text-card-foreground">{formatTime(app.created_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">状态：</span>
              <StatusBadge status={app.status} />
            </div>
          </ContentGrid>

        </div>
      </details>

      {/* Danger zone */}
      <details className="panel">
        <summary className="cursor-pointer text-sm text-muted-foreground">移除应用</summary>
        <div className="mt-4"><p className="mb-3 text-xs text-muted-foreground">{app.source === 'local' ? '移除平台中的注册信息，保留本机原程序。' : '移除注册信息并删除此应用上传的文件。'}</p>
          <Button variant="destructive" size="sm" disabled={!!pending || !!loadError} onClick={handleDelete}>
            <Trash2 className="w-3 h-3" /> {app.source==='local'?'移除平台注册':'删除应用'}
          </Button>
        </div>
      </details>
      </aside>
      </ContentGrid>
    </Page>
  )
}
