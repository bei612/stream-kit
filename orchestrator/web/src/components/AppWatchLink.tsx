import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

export default function AppWatchLink({ appId }: { appId: string }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let active = true
    setPath(''); setError(''); setCopied(false)
    api.watchLink(appId).then(r => { if (active) setPath(r.data?.path || '') })
      .catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [appId])
  const change = async (method: string) => {
    if (busy) return
    if (method === 'PUT' && !confirm('重置后旧观看链接立即失去加入权限，已连接的设备不会被踢出。是否重置？')) return
    if (method === 'DELETE' && !confirm('关闭固定链接后，不能再通过它进入应用。已连接的设备不会被踢出。是否关闭？')) return
    setBusy(true); setError(''); setCopied(false)
    try { const r = await api.watchLink(appId, method); setPath(r.data?.path || '') }
    catch (e) { setError(e instanceof Error ? e.message : '无法更新观看链接') }
    finally { setBusy(false) }
  }
  const link = path ? new URL(path, window.location.origin).toString() : ''
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
    <div><h3 className="text-sm font-semibold">固定观看链接</h3>
      <p className="mt-1 text-xs text-muted-foreground">长期有效，无需观看账号。打开即按已保存的启动参数启动应用或加入现有串流，可保存到 iPad 书签。</p></div>
    {link && <>
      <Textarea aria-label="固定观看链接" value={link} readOnly rows={2} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
      <p className="text-xs text-muted-foreground">可选择上方地址手动复制。只有重置、关闭链接或移除应用后，旧链接才失效。</p>
      {['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) && <p className="text-xs text-amber-400">当前管理页使用本机地址。分享给其他设备前，请通过局域网地址打开管理页后复制链接。</p>}
    </>}
    <div className="flex flex-wrap gap-2">
      {!link ? <Button disabled={busy} onClick={() => change('POST')}>启用固定链接</Button> : <>
        <a className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={link} target="_blank" rel="noopener noreferrer">打开观看</a>
        {navigator.clipboard?.writeText && <Button variant="outline" onClick={async () => {
          try { await navigator.clipboard.writeText(link); setCopied(true); setError('') }
          catch { setError('请选择上方地址手动复制。') }
        }}>{copied ? '已复制' : '复制链接'}</Button>}
        <Button variant="outline" disabled={busy} onClick={() => change('PUT')}>重置链接</Button>
        <Button variant="ghost" disabled={busy} onClick={() => change('DELETE')}>关闭链接</Button>
      </>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
