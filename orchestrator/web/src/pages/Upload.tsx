import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { argsToLines, linesToArgs } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input, Textarea, Select, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Upload as UploadIcon, X } from 'lucide-react'

export default function UploadPage() {
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
      if (!name) setName(f.name.replace(/\.(zip|tar|tar\.gz|tgz|tar\.bz2)$/i, ''))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !name) return

    setUploading(true)
    setError('')
    setProgress(0)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('name', name)

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
      setProgress(100)
      setUploading(false)
      setTimeout(() => {
        navigate(`/apps/${(res as any).data?.app_id || ''}`)
      }, 1000)
    } catch (err: any) {
      setError(err.message)
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
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">上传应用</h2>

      {blocked && !uploading && (
        <Alert variant="warning">当前有其他应用正在上传或解压中，请等待完成后再上传。</Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Drop zone */}
        <Card
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed p-8 text-center cursor-pointer hover:border-primary transition-colors"
        >
          {file ? (
            <div className="flex items-center justify-center gap-2">
              <span className="text-sm font-medium text-card-foreground">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                ({(file.size / 1024 / 1024).toFixed(1)} MB)
              </span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setFile(null) }}
                className="text-red-300 hover:text-red-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div>
              <UploadIcon className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                拖拽文件到此处，或点击选择文件
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                支持 zip、tar.gz、tar.bz2 格式
              </p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) {
                setFile(f)
                if (!name) setName(f.name.replace(/\.(zip|tar|tar\.gz|tgz|tar\.bz2)$/i, ''))
              }
            }}
          />
        </Card>

        {/* App name */}
        <div>
          <Label>应用名称</Label>
          <Input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="如：我的应用"
            required
          />
        </div>

        {/* Args mode selector */}
        <div>
          <Label>启动参数</Label>
          <Select
            value={argsMode}
            onChange={e => setArgsMode(e.target.value)}
          >
            <option value="none">无参数（直接运行）</option>
            {Object.entries(templates).map(([key]) => (
              <option key={key} value={key}>模板：{key}</option>
            ))}
            <option value="custom">自定义参数</option>
          </Select>
        </div>

        {/* Template preview (read-only) */}
        {templatePreview && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">模板参数预览</label>
            <pre className="px-3 py-2 border rounded-md bg-muted text-xs font-mono whitespace-pre-wrap text-card-foreground">
              {templatePreview}
            </pre>
          </div>
        )}

        {/* Custom args (multi-line) */}
        {argsMode === 'custom' && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              每行一个参数，含空格的路径请用引号包裹
            </label>
            <Textarea
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
              <span>上传进度</span>
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
          disabled={!file || !name || uploading || blocked}
          className="w-full"
        >
          {uploading ? '上传中...' : '开始上传'}
        </Button>

        {uploading && (
          <Button
            type="button"
            variant="outline"
            onClick={() => abortRef.current?.()}
            className="w-full border-red-400/30 text-red-300 hover:bg-red-900/20"
          >
            取消上传
          </Button>
        )}
      </form>
    </div>
  )
}
