import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { useManagementLocale } from '@/i18n'

export default function AppWatchLink({ appId }: { appId: string }) {
  return <AppWatchLinkContent key={appId} appId={appId} />
}

type LinkView = {
  phase: 'loading' | 'ready' | 'changing' | 'unavailable'
  path: string
  stableOrigin: string
  error: '' | 'watchLink.loadFailed' | 'watchLink.changeFailed' | 'watchLink.copyFailed'
  copied: boolean
}

function responseLink(result: Awaited<ReturnType<typeof api.watchLink>>): Pick<LinkView, 'path' | 'stableOrigin'> {
  const data = result.data
  if (!data || typeof data.enabled !== 'boolean' || typeof data.path !== 'string' ||
      (data.enabled ? !/^\/watch#key=[A-Za-z0-9_-]{43}$/.test(data.path) : data.path !== '')) {
    throw new Error('Invalid permanent viewing link response')
  }
  if (data.stable_origin === undefined || data.stable_origin === '') return { path: data.path, stableOrigin: '' }
  const origin = new URL(data.stable_origin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Invalid permanent viewing origin')
  }
  return { path: data.path, stableOrigin: origin.origin }
}

function AppWatchLinkContent({ appId }: { appId: string }) {
  const { t } = useManagementLocale()
  const [view, setView] = useState<LinkView>({ phase: 'loading', path: '', stableOrigin: '', error: '', copied: false })
  const revision = useRef(0)
  const nextRevision = useCallback(() => ++revision.current, [])
  const inFlight = useRef(true)
  const load = useCallback(async () => {
    const request = nextRevision()
    inFlight.current = true
    setView({ phase: 'loading', path: '', stableOrigin: '', error: '', copied: false })
    try {
      const link = responseLink(await api.watchLink(appId))
      if (request === revision.current) setView({ phase: 'ready', ...link, error: '', copied: false })
    } catch {
      if (request === revision.current) setView({ phase: 'unavailable', path: '', stableOrigin: '', error: 'watchLink.loadFailed', copied: false })
    } finally {
      if (request === revision.current) inFlight.current = false
    }
  }, [appId, nextRevision])
  useEffect(() => {
    void load()
    return () => { nextRevision(); inFlight.current = true }
  }, [load, nextRevision])
  const change = async (method: 'POST' | 'PUT' | 'DELETE') => {
    if (inFlight.current || view.phase !== 'ready') return
    if (method === 'PUT' && !confirm(t('watchLink.confirmRotate'))) return
    if (method === 'DELETE' && !confirm(t('watchLink.confirmDisable'))) return
    const request = nextRevision()
    inFlight.current = true
    setView(current => ({ ...current, phase: 'changing', error: '', copied: false }))
    try {
      const link = responseLink(await api.watchLink(appId, method))
      if (request === revision.current) setView({ phase: 'ready', ...link, error: '', copied: false })
    } catch {
      // A failed response does not prove that the server did not rotate/delete
      // the capability. Read authoritative state before exposing a URL again.
      if (request === revision.current) setView({ phase: 'unavailable', path: '', stableOrigin: '', error: 'watchLink.changeFailed', copied: false })
    } finally {
      if (request === revision.current) inFlight.current = false
    }
  }
  const busy = view.phase !== 'ready'
  const link = view.phase === 'ready' && view.path ? new URL(view.path, view.stableOrigin || window.location.origin).toString() : ''
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
    <div><h3 className="text-sm font-semibold">{t('watchLink.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('watchLink.description')}</p></div>
    {view.phase === 'loading' && <p role="status" className="text-xs text-muted-foreground">{t('watchLink.loading')}</p>}
    {view.phase === 'changing' && <p role="status" className="text-xs text-muted-foreground">{t('watchLink.changing')}</p>}
    {link && <>
      <Textarea aria-label={t('watchLink.title')} value={link} readOnly rows={2} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
      <p className="text-xs text-muted-foreground">{t('watchLink.copyHelp')}</p>
      {view.stableOrigin && <p className="text-xs text-muted-foreground">{t('watchLink.stableAddress')}</p>}
      {!view.stableOrigin && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) && <p className="text-xs text-amber-400">{t('watchLink.loopback')}</p>}
    </>}
    <div className="flex flex-wrap gap-2">
      {view.phase === 'unavailable' ? <Button variant="outline" onClick={() => void load()}>{t('watchLink.reload')}</Button> : !view.path ? <Button disabled={busy} onClick={() => change('POST')}>{t('watchLink.enable')}</Button> : <>
        {link && <a className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={link} target="_blank" rel="noopener noreferrer">{t('watchLink.open')}</a>}
        {link && navigator.clipboard?.writeText && <Button variant="outline" onClick={async () => {
          const request = revision.current
          try { await navigator.clipboard.writeText(link); if (request === revision.current) setView(current => ({ ...current, copied: true, error: '' })) }
          catch { if (request === revision.current) setView(current => ({ ...current, error: 'watchLink.copyFailed' })) }
        }}>{t(view.copied ? 'watchLink.copied' : 'watchLink.copy')}</Button>}
        <Button variant="outline" disabled={busy} onClick={() => change('PUT')}>{t('watchLink.rotate')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => change('DELETE')}>{t('watchLink.disable')}</Button>
      </>}
    </div>
    {view.error && <p role="alert" className="text-sm text-destructive">{t(view.error)}</p>}
  </section>
}
