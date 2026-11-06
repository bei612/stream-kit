import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

export default function AppWatchLink({ appId }: { appId: string }) {
  return <AppWatchLinkContent key={appId} appId={appId} />
}

type LinkView = {
  phase: 'loading' | 'ready' | 'changing' | 'unavailable'
  path: string
  error: string
  copied: boolean
}

function responsePath(result: Awaited<ReturnType<typeof api.watchLink>>): string {
  const data = result.data
  if (!data || typeof data.enabled !== 'boolean' || typeof data.path !== 'string' ||
      (data.enabled ? !/^\/watch#key=[A-Za-z0-9_-]{43}$/.test(data.path) : data.path !== '')) {
    throw new Error('服务器未返回有效的链接状态，请重新读取')
  }
  return data.path
}

function AppWatchLinkContent({ appId }: { appId: string }) {
  const [view, setView] = useState<LinkView>({ phase: 'loading', path: '', error: '', copied: false })
  const revision = useRef(0)
  const inFlight = useRef(true)
  const load = useCallback(async () => {
    const request = ++revision.current
    inFlight.current = true
    setView({ phase: 'loading', path: '', error: '', copied: false })
    try {
      const path = responsePath(await api.watchLink(appId))
      if (request === revision.current) setView({ phase: 'ready', path, error: '', copied: false })
    } catch (error) {
      if (request === revision.current) setView({ phase: 'unavailable', path: '', error: error instanceof Error ? error.message : '无法读取观看链接', copied: false })
    } finally {
      if (request === revision.current) inFlight.current = false
    }
  }, [appId])
  useEffect(() => {
    void load()
    return () => { revision.current++; inFlight.current = true }
  }, [load])
  const change = async (method: string) => {
    if (inFlight.current || view.phase !== 'ready') return
    if (method === 'PUT' && !confirm('重置后旧观看链接立即失去加入权限，已连接的设备不会被踢出。是否重置？')) return
    if (method === 'DELETE' && !confirm('关闭固定链接后，不能再通过它进入应用。已连接的设备不会被踢出。是否关闭？')) return
    const request = ++revision.current
    inFlight.current = true
    setView(current => ({ ...current, phase: 'changing', error: '', copied: false }))
    try {
      const path = responsePath(await api.watchLink(appId, method))
      if (request === revision.current) setView({ phase: 'ready', path, error: '', copied: false })
    } catch (error) {
      // A failed response does not prove that the server did not rotate/delete
      // the capability. Read authoritative state before exposing a URL again.
      if (request === revision.current) setView({ phase: 'unavailable', path: '', error: error instanceof Error ? error.message : '链接更新结果未确认', copied: false })
    } finally {
      if (request === revision.current) inFlight.current = false
    }
  }
  const busy = view.phase !== 'ready'
  const link = view.phase === 'ready' && view.path ? new URL(view.path, window.location.origin).toString() : ''
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
    <div><h3 className="text-sm font-semibold">固定观看链接</h3>
      <p className="mt-1 text-xs text-muted-foreground">长期有效，无需观看账号。打开即按已保存的启动参数启动应用或加入现有串流，可保存到 iPad 书签。</p></div>
    {view.phase === 'loading' && <p role="status" className="text-xs text-muted-foreground">正在读取链接状态…</p>}
    {view.phase === 'changing' && <p role="status" className="text-xs text-muted-foreground">正在更新链接…</p>}
    {link && <>
      <Textarea aria-label="固定观看链接" value={link} readOnly rows={2} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
      <p className="text-xs text-muted-foreground">可选择上方地址手动复制。只有重置、关闭链接或移除应用后，旧链接才失效。</p>
      {['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) && <p className="text-xs text-amber-400">当前管理页使用本机地址。分享给其他设备前，请通过局域网地址打开管理页后复制链接。</p>}
    </>}
    <div className="flex flex-wrap gap-2">
      {view.phase === 'unavailable' ? <Button variant="outline" onClick={() => void load()}>重新读取链接</Button> : !view.path ? <Button disabled={busy} onClick={() => change('POST')}>启用固定链接</Button> : <>
        {link && <a className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={link} target="_blank" rel="noopener noreferrer">打开观看</a>}
        {link && navigator.clipboard?.writeText && <Button variant="outline" onClick={async () => {
          const request = revision.current
          try { await navigator.clipboard.writeText(link); if (request === revision.current) setView(current => ({ ...current, copied: true, error: '' })) }
          catch { if (request === revision.current) setView(current => ({ ...current, error: '请选择上方地址手动复制。' })) }
        }}>{view.copied ? '已复制' : '复制链接'}</Button>}
        <Button variant="outline" disabled={busy} onClick={() => change('PUT')}>重置链接</Button>
        <Button variant="ghost" disabled={busy} onClick={() => change('DELETE')}>关闭链接</Button>
      </>}
    </div>
    {view.error && <p role="alert" className="text-sm text-destructive">{view.error}</p>}
  </section>
}
