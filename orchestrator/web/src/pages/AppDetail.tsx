import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { api } from '@/api/client'
import StatusBadge from '@/components/StatusBadge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'
import { formatBytes, formatTime, argsToLines, linesToArgs } from '@/lib/utils'
import { ArrowLeft, ExternalLink, Trash2, Save, RotateCcw, Play, Square, Copy, Check } from 'lucide-react'

export default function AppDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [app, setApp] = useState<any>(null)
  const [args, setArgs] = useState('')
  const [argsDirty, setArgsDirty] = useState(false)
  const argsDirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
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
    if (!id) return
    setSaving(true)
    try {
      await api.updateApp(id, { args: linesToArgs(args) })
      argsDirtyRef.current = false
      setArgsDirty(false)
      await refresh()
    } catch (e: any) {
      alert(e.message)
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    if (!id || !app) return
    if (!confirm(`确定删除应用 "${app.name}"？`)) return
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
    if (!id) return
    try {
      await api.retryRegister(id)
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const [launching, setLaunching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [copied, setCopied] = useState(false)

  // Build full stream URL from "port/path" using current hostname
  const buildStreamURL = (portPath: string) => {
    if (!portPath) return ''
    const hostname = window.location.hostname
    return `http://${hostname}:${portPath}`
  }

  const handleLaunch = async () => {
    if (!id) return
    setLaunching(true)
    try {
      const res = await api.launchApp(id)
      const portPath = (res.data as any)?.stream_url
      if (portPath) {
        window.open(buildStreamURL(portPath), '_blank')
      }
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

  return (
    <div className="max-w-3xl space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/apps')}>
        <ArrowLeft className="w-4 h-4" /> 返回应用列表
      </Button>

      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-bold text-card-foreground">{app.name}</h2>
        <StatusBadge status={app.status} />
      </div>

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
                    onClick={() => {
                      navigator.clipboard.writeText(buildStreamURL(app.stream_url))
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    {copied ? '已复制' : '复制分享链接'}
                  </Button>
                )}
              </>
            )}
          </div>
          {app.status === 'running' && app.stream_url && (
            <div className="mt-3 text-xs text-muted-foreground font-mono bg-muted rounded px-3 py-2 break-all select-all">
              {buildStreamURL(app.stream_url)}
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
          <p className="text-sm mb-2">编码器注册失败: {app.error_message}</p>
          <Button size="sm" onClick={handleRetryRegister} className="bg-blue-600 text-white hover:bg-blue-700">
            <RotateCcw className="w-3 h-3" /> 重试注册
          </Button>
        </Alert>
      )}

      {/* Info */}
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">入口文件：</span>
              <span className="break-all text-card-foreground">{app.exe_relative_path || '-'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">大小：</span>
              <span className="text-card-foreground">{formatBytes(app.extracted_size_bytes || app.file_size_bytes)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">上传时间：</span>
              <span className="text-card-foreground">{formatTime(app.created_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">状态：</span>
              <span className="text-card-foreground">{app.status}</span>
            </div>
          </div>

        </CardContent>
      </Card>

      {/* Args editing */}
      <Card>
        <CardHeader>
          <CardTitle>启动参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">每行一个参数，含空格的路径请用引号包裹</p>
          <Textarea
            value={args}
            onChange={e => { setArgs(e.target.value); setArgsDirty(true); argsDirtyRef.current = true }}
            rows={5}
            placeholder={"无启动参数"}
            className="font-mono"
          />
          <Button
            onClick={handleSave}
            disabled={saving || linesToArgs(args) === (app.args || '')}
            size="sm"
          >
            <Save className="w-3 h-3" /> {saving ? '保存中...' : '保存'}
          </Button>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-red-400/20">
        <CardHeader>
          <CardTitle className="text-red-300">危险操作</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="w-3 h-3" /> 删除应用
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
