import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { api } from '@/api/client'
import { createViewingInvitation, openViewingStream } from '@/lib/stream-access'
import StatusBadge from '@/components/StatusBadge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'
import { formatBytes, formatTime, argsToLines, linesToArgs } from '@/lib/utils'
import { ArrowLeft, Trash2, Save, RotateCcw, Play, Square, Copy, Check } from 'lucide-react'
import CaptureModeField, { type CaptureMode } from '@/components/CaptureModeField'

export default function AppDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [app, setApp] = useState<any>(null)
  const [args, setArgs] = useState('')
  const [captureMode,setCaptureMode]=useState<CaptureMode>('desktop')
  const [argsDirty, setArgsDirty] = useState(false)
  const argsDirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [saveNotice, setSaveNotice] = useState<{kind:'error'|'success';message:string}|null>(null)
  const [retrying, setRetrying] = useState(false)
  const [candidates, setCandidates] = useState<any[]>([])

  const [loadError, setLoadError] = useState('')

  const refresh = async () => {
    if (!id) return
    try {
      const res = await api.getApp(id)
      setApp(res.data)
      setLoadError('')
      if (!argsDirtyRef.current) {
        setArgs(argsToLines(res.data?.args || ''))
        setCaptureMode(res.data?.capture_mode || 'desktop')
      }

      if (res.data?.status === 'detecting') {
        const cands = await api.getAppCandidates(id)
        setCandidates(cands.data || [])
      }
    } catch (e: any) {
      setLoadError(e.message || '加载失败')
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    // Also refresh immediately on WebSocket app_status events
    const onWsEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.type === 'app_status') refresh()
    }
    window.addEventListener('ws-event', onWsEvent)
    return () => {
      clearInterval(t)
      window.removeEventListener('ws-event', onWsEvent)
    }
  }, [id])

  const handleSave = async () => {
    if (!id || saving) return
    setSaving(true)
    setSaveNotice(null)
    try {
      await api.updateApp(id, { args: linesToArgs(args), capture_mode:captureMode })
      argsDirtyRef.current = false
      setArgsDirty(false)
      await refresh()
      setSaveNotice({kind:'success',message:'配置已保存，下次启动应用时生效。'})
    } catch (e: unknown) {
      setSaveNotice({kind:'error',message:e instanceof Error?e.message:'配置保存失败，请重试。'})
      // A failed native apply can still leave durable desired settings. Refresh
      // status immediately, preserving the draft until successful submission.
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!id || !app) return
    if (!confirm(app.source==='local' ? `移除 "${app.name}" 的平台注册？原程序及工作目录会保留。` : `确定删除应用 "${app.name}" 及上传文件？`)) return
    try {
      await api.deleteApp(id)
      navigate('/apps')
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleSelectExe = async (exePath: string) => {
    if (!id) return
    try {
      await api.selectExe(id, exePath)
      setCandidates([])
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleRetryRegister = async () => {
    if (!id || retrying) return
    setRetrying(true)
    setSaveNotice(null)
    try {
      await api.retryRegister(id)
      await refresh()
    } catch (e: unknown) {
      setSaveNotice({kind:'error',message:e instanceof Error?e.message:'无法重试注册。'})
    } finally {
      setRetrying(false)
    }
  }

  const [launching, setLaunching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleLaunch = async () => {
    if (!id) return
    setLaunching(true)
    try {
      await openViewingStream(async () => {
        const res = await api.launchApp(id)
        return res.data?.stream_url
      })
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
    setLaunching(false)
  }

  const handleStopStream = async () => {
    if (!id) return
    setStopping(true)
    try {
      await api.stopApp(id)
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
    setStopping(false)
  }

  if (loadError && !app) return (
    <div className="text-center py-12">
      <p className="text-destructive mb-3">{loadError}</p>
      <Button variant="outline" onClick={refresh}>重试</Button>
    </div>
  )
  if (!app) return <div className="text-muted-foreground">加载中...</div>

  const settingsEditable = ['ready','stopped','crashed','register_failed'].includes(app.status)
  const settingsDisabled = saving || retrying || !settingsEditable

  return (
    <div className="max-w-3xl space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/apps')}>
        <ArrowLeft className="w-4 h-4" /> 返回应用列表
      </Button>

      <div className="flex items-center gap-3">
        <h2 className="min-w-0 break-words text-2xl font-bold text-card-foreground">{app.name}</h2>
        <div className="shrink-0"><StatusBadge status={app.status} /></div>
      </div>
      {loadError && <Alert variant="warning" role="status">状态刷新失败：{loadError}。当前显示上次读取的状态。</Alert>}

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
          <div className="flex flex-wrap items-center gap-3">
            {(app.status === 'ready' || app.status === 'stopped' || app.status === 'crashed') && (
              <Button onClick={handleLaunch} disabled={launching}>
                <Play className="w-4 h-4" /> {launching ? '启动中...' : '启动串流'}
              </Button>
            )}
            {app.status === 'running' && (
              <>
                <Button variant="destructive" onClick={handleStopStream} disabled={stopping}>
                  <Square className="w-4 h-4" /> {stopping ? '停止中...' : '停止串流（含程序）'}
                </Button>
                {app.stream_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(await createViewingInvitation(app.stream_url))
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      } catch (error: unknown) {
                        alert(error instanceof Error ? error.message : '无法创建观看链接')
                      }
                    }}
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    {copied ? '已复制' : '复制观看链接（2 分钟有效）'}
                  </Button>
                )}
              </>
            )}
          </div>
          {app.status === 'running' && app.stream_url && (
            <div className="mt-3 text-xs text-muted-foreground font-mono bg-muted rounded px-3 py-2 break-all select-all">
              使用启动按钮或观看链接进入串流，无需注册观看账号；链接在两分钟内可加入，已加入的连接通过心跳续期。
            </div>
          )}
        </CardContent>
      </Card>

      {/* Exe selection dialog */}
      {app.status === 'detecting' && candidates.length > 0 && (
        <Alert variant="warning">
          <p className="font-medium mb-2">检测到多个可执行文件，请选择入口：</p>
          <div className="space-y-2">
            {candidates.map((c: any) => (
              <Button
                key={c.relative_path}
                variant="outline"
                onClick={() => handleSelectExe(c.relative_path)}
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

      {/* Info */}
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
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
          </div>

        </CardContent>
      </Card>

      {/* Args editing */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">采集与启动配置
            <span className="text-xs font-normal text-muted-foreground">下次启动应用生效</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!settingsEditable && <Alert variant="info" role="status">{app.status==='running'?'请先停止串流，再修改采集范围和启动参数。':'应用正在处理，请等待处理完成后修改配置。'}</Alert>}
          <CaptureModeField value={captureMode} disabled={settingsDisabled} onChange={mode=>{setCaptureMode(mode);setArgsDirty(true);argsDirtyRef.current=true;setSaveNotice(null)}} />
          <label htmlFor="application-args" className="block text-sm font-medium">启动参数</label>
          <p id="application-args-help" className="text-xs text-muted-foreground">每行一个参数，含空格的路径请用引号包裹</p>
          <Textarea
            id="application-args"
            aria-describedby="application-args-help"
            disabled={settingsDisabled}
            value={args}
            onChange={e => { setArgs(e.target.value); setArgsDirty(true); argsDirtyRef.current = true; setSaveNotice(null) }}
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
          </Button>{argsDirty && <span className="text-xs text-muted-foreground">正在编辑 · 尚未确认应用</span>}</div>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-red-400/20">
        <CardHeader>
          <CardTitle className="text-red-300">危险操作</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="w-3 h-3" /> {app.source==='local'?'移除平台注册':'删除应用'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
