import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { viewingURL } from '@/lib/stream-access'
import { useManagementLocale } from '@/i18n'

// Keep the durable address in the top-level page. The embedded viewer receives
// only a fresh, restricted invitation, so reload/bookmark never loses the link.
export default function Watch() {
  const { hash } = useLocation()
  const [attempt, setAttempt] = useState(0)
  return <WatchAttempt key={`${hash}:${attempt}`} hash={hash} retry={() => setAttempt(n => n + 1)} />
}

// A new capability or explicit retry owns a new request/iframe lifetime. The
// old attempt unmounts immediately and aborts its outstanding admission.
function WatchAttempt({ hash, retry }: { hash: string; retry: () => void }) {
  const { t } = useManagementLocale()
  const [stream, setStream] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 120000)
    const key = new URLSearchParams(hash.slice(1)).get('key')
    const open = async () => {
      if (!key) throw new Error(t('watch.invalid'))
      while (!abort.signal.aborted) {
      const response = await fetch('/api/v1/watch/open', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
        signal: abort.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      })
      const result = await response.json()
      if (response.status === 503 && ['APP_UNAVAILABLE', 'MEDIA_CONTROL_UNAVAILABLE'].includes(result.code)) {
        // Windows can accept HTTP before the user's render desktop is ready.
        // Keep the same capability and wait within the overall startup deadline.
        await new Promise<void>(resolve => {
          const retry = setTimeout(done, 2500)
          function done() { clearTimeout(retry); abort.signal.removeEventListener('abort', done); resolve() }
          abort.signal.addEventListener('abort', done, { once: true })
          if (abort.signal.aborted) done()
        })
        continue
      }
      if (!response.ok || result.status !== 'ok') throw new Error(result.message || t('watch.unavailable'))
      const port = response.headers.get('X-Stream-Port')
      if (!port || !/^\d+$/.test(port)) throw new Error(t('watch.invalidMedia'))
      const source = new URL(`${window.location.protocol}//${window.location.hostname}:${port}/stream.html`)
      source.searchParams.set('hostId', String(result.data.host_id))
      source.searchParams.set('appId', String(result.data.app_id))
      const url = viewingURL(source, result.data)
      if (!abort.signal.aborted) setStream(url)
      return
      }
    }
    open().catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : t('watch.unavailable')) }).finally(() => clearTimeout(timer))
    const timeoutMessage = () => setError(t('watch.timeout'))
    abort.signal.addEventListener('abort', timeoutMessage)
    return () => { clearTimeout(timer); abort.signal.removeEventListener('abort', timeoutMessage); abort.abort() }
  }, [hash, t])
  if (stream) return <iframe title={t('watch.iframeTitle')} src={stream} className="fixed inset-0 h-dvh w-full border-0 bg-black"
    allow="autoplay; fullscreen; microphone; gamepad" allowFullScreen referrerPolicy="no-referrer" />
  return <main className="min-h-dvh flex items-center justify-center bg-background px-6 text-foreground">
    <div className="max-w-lg text-center space-y-4">
      <p className="text-xs tracking-widest text-muted-foreground">{t('brand.client')}</p>
      <h1 className="text-2xl font-semibold">{error ? t('watch.unavailable') : t('watch.entering')}</h1>
      <p role="status" className="text-sm text-muted-foreground">{error || t('watch.preparing')}</p>
      {error && <button className="rounded-md bg-primary text-primary-foreground px-5 py-2" onClick={retry}>{t('watch.retry')}</button>}
    </div>
  </main>
}
