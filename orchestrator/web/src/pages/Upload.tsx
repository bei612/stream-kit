import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { api, UploadTimeoutError } from '@/api/client'
import { argsToLines, linesToArgs } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { ContentGrid, Page } from '@/components/layout/Page'
import { Input, Textarea, Select, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Upload as UploadIcon, X } from 'lucide-react'
import CaptureModeField, { type CaptureMode } from '@/components/CaptureModeField'
import { useManagementLocale } from '@/i18n'

export default function UploadPage() {
  const { t } = useManagementLocale()
  const [captureMode,setCaptureMode]=useState<CaptureMode>('desktop')
  const [source,setSource]=useState<'archive'|'local'>('archive')
  const [exePath,setExePath]=useState('')
  const [workingDir,setWorkingDir]=useState('')
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [argsMode, setArgsMode] = useState('none')
  const [customArgsText, setCustomArgsText] = useState('')
  const [progress, setProgress] = useState(-1)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [blocked, setBlocked] = useState(false) // another upload in progress
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const navigate = useNavigate()

  useEffect(() => () => abortRef.current?.(), [])

  useEffect(() => {
    api.getTemplates().then(r => setTemplates(r.data || {})).catch(() => {})
    // Check if another upload is in progress
    api.uploadStatus().then(r => setBlocked(r.data?.uploading || false)).catch(() => {})
    const t = setInterval(() => {
      api.uploadStatus().then(r => setBlocked(r.data?.uploading || false)).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) {
      setFile(f)
      if (!name) setName(f.name.replace(/\.(tar\.(gz|bz2|xz|zst)|zip|7z|rar|tar|tgz|tbz2|txz|tzst)$/i, ''))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || (source==='archive' ? !file : !exePath)) return

    setUploading(true)
    setError('')
    setProgress(source==='archive' ? 0 : -1)

    if (source==='local') {
      try {
        const result=await api.registerLocalApp({name,exe_path:exePath,working_dir:workingDir,args:argsMode==='custom'?linesToArgs(customArgsText):'',args_template:argsMode!=='none'&&argsMode!=='custom'?argsMode:'',capture_mode:captureMode})
        if (!result.data?.id) throw new Error(t('upload.registerNoId'))
        navigate(`/apps/${result.data.id}`)
      } catch (err:unknown) { setError(err instanceof Error ? err.message : t('upload.registerFailed')) } finally { setUploading(false) }
      return
    }

    const fd = new FormData()
    fd.append('file', file!)
    fd.append('name', name)
    fd.append('capture_mode',captureMode)

    if (argsMode === 'custom') {
      const args = linesToArgs(customArgsText)
      if (args) fd.append('args', args)
    } else if (argsMode !== 'none') {
      fd.append('args_template', argsMode)
    }

    try {
      const { promise, abort } = api.uploadApp(fd, setProgress)
      abortRef.current = abort
      const res = await promise
      if (!res.data?.app_id) throw new Error(t('upload.uploadNoId'))
      setProgress(100)
      setUploading(false)
      navigate(`/apps/${res.data.app_id}`)
    } catch (err: unknown) {
      setError(err instanceof UploadTimeoutError ? t('upload.idleTimeout') : err instanceof Error ? err.message : t('upload.uploadFailed'))
      setUploading(false)
    } finally {
      abortRef.current = null
    }
  }

  // Get the preview text for a selected template
  const templatePreview = argsMode !== 'none' && argsMode !== 'custom' && templates[argsMode]
    ? argsToLines(templates[argsMode])
    : ''

  return (
    <Page title={t('upload.title')} eyebrow={t('upload.eyebrow')} description={t('upload.description')}>
      <ContentGrid variant="detail">
      <div className="page-stack">
      <div className="action-row" role="group" aria-label={t('upload.source')}>
        <Button type="button" variant={source==='archive'?'primary':'outline'} aria-pressed={source==='archive'} disabled={uploading} onClick={()=>{setSource('archive');setError('');setProgress(-1)}}>{t('upload.archive')}</Button>
        <Button type="button" variant={source==='local'?'primary':'outline'} aria-pressed={source==='local'} disabled={uploading} onClick={()=>{setSource('local');setError('');setProgress(-1)}}>{t('upload.local')}</Button>
      </div>

      {source==='archive' && blocked && !uploading && (
        <Alert variant="warning">{t('upload.blocked')}</Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Drop zone */}
        {source==='archive' ? <Card
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          className="border-2 border-dashed p-8 text-center hover:border-primary transition-colors"
        >
          {file ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="min-w-0 break-all text-sm font-medium text-card-foreground">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                ({(file.size / 1024 / 1024).toFixed(1)} MB)
              </span>
              <button
                type="button"
                aria-label={t('upload.removeArchive')}
                disabled={uploading}
                onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = '' }}
                className="text-red-300 hover:text-red-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div>
              <UploadIcon className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <Button type="button" variant="ghost" className="max-w-full whitespace-normal" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {t('upload.dropzone')}
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                {t('upload.formats')}
              </p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.7z,.rar,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz,.tar.zst,.tzst"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) {
                setFile(f)
                if (!name) setName(f.name.replace(/\.(tar\.(gz|bz2|xz|zst)|zip|7z|rar|tar|tgz|tbz2|txz|tzst)$/i, ''))
              }
            }}
          />
        </Card> : <Card className="p-5 space-y-4">
          <p className="text-sm text-muted-foreground">{t('upload.localDescription')}</p>
          <div><Label htmlFor="local-executable">{t('upload.executablePath')}</Label><Input id="local-executable" value={exePath} onChange={e=>setExePath(e.target.value)} placeholder={t('upload.executablePlaceholder')} required autoComplete="off" /></div>
          <div><Label htmlFor="local-working-dir">{t('upload.workingDir')}</Label><Input id="local-working-dir" value={workingDir} onChange={e=>setWorkingDir(e.target.value)} placeholder={t('upload.workingDirPlaceholder')} autoComplete="off" /></div>
          <p className="text-xs text-muted-foreground">{t('upload.localHint')}</p>
        </Card>}

        {/* App name */}
        <div>
          <Label htmlFor="application-name">{t('upload.appName')}</Label>
          <Input
            id="application-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('upload.appNamePlaceholder')}
            required
          />
        </div>

        {/* Args mode selector */}
        <CaptureModeField value={captureMode} onChange={setCaptureMode} disabled={uploading} />
        <div>
          <Label htmlFor="application-args-mode">{t('upload.launchArgs')}</Label>
          <Select
            id="application-args-mode"
            value={argsMode}
            onChange={e => setArgsMode(e.target.value)}
          >
            <option value="none">{t('upload.noArgs')}</option>
            {Object.entries(templates).map(([key]) => (
              <option key={key} value={key}>{t('upload.template')}: {key}</option>
            ))}
            <option value="custom">{t('upload.customArgs')}</option>
          </Select>
        </div>

        {/* Template preview (read-only) */}
        {templatePreview && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('upload.templatePreview')}</label>
            <pre className="px-3 py-2 border rounded-md bg-muted text-xs font-mono whitespace-pre-wrap text-card-foreground">
              {templatePreview}
            </pre>
          </div>
        )}

        {/* Custom args (multi-line) */}
        {argsMode === 'custom' && (
          <div>
            <label htmlFor="new-application-args" className="block text-xs text-muted-foreground mb-1">
              {t('upload.argsHelp')}
            </label>
            <Textarea
              id="new-application-args"
              value={customArgsText}
              onChange={e => setCustomArgsText(e.target.value)}
              rows={5}
              placeholder={"-game\n-fullscreen\n-ResX=1920\n-ResY=1080"}
              className="font-mono"
            />
          </div>
        )}

        {/* Progress */}
        {progress >= 0 && (
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>{t('upload.progress')}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className="bg-primary h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <Alert variant="error">{error}</Alert>
        )}

        <Button
          type="submit"
          disabled={!name || uploading || (source==='archive'? !file || blocked : !exePath)}
          className="w-full"
        >
          {uploading ? (source==='archive'?t('upload.uploading'):t('upload.registering')) : (source==='archive'?t('upload.startUpload'):t('upload.registerLocal'))}
        </Button>

        {uploading && source==='archive' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => abortRef.current?.()}
            className="w-full border-red-400/30 text-red-300 hover:bg-red-900/20"
          >
            {t('upload.cancel')}
          </Button>
        )}
      </form>
      </div>
      <Card className="form-aside">
        <h3>{source === 'local' ? t('upload.localAsideTitle') : t('upload.archiveAsideTitle')}</h3>
        <ul>
          {source === 'local' ? <>
            <li>填写服务器本机的绝对路径，而非当前访问设备的路径。</li>
            <li>程序所需资源与运行库应已安装；工作目录影响相对资源加载。</li>
            <li>移除平台注册会保留外部原程序与工作目录。</li>
          </> : <>
            <li>支持 ZIP、7z、RAR、TAR 及常用压缩 TAR，程序文件应完整包含在包中。</li>
            <li>加密包、分卷包及链接文件不作为应用包支持。</li>
            <li>完成解压后可选择真实启动入口，再生成固定观看链接。</li>
          </>}
          <li>单个渲染主机同时串流一个应用，多个客户端共享画面。</li>
        </ul>
      </Card>
      </ContentGrid>
    </Page>
  )
}
