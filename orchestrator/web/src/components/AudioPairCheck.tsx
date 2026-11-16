import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { AudioDevice, AudioPairCheckResult } from '@/api/audio-devices'
import { Button } from '@/components/ui/button'
import { Select, Label } from '@/components/ui/input'
import { useManagementLocale } from '@/i18n'

export function AudioPairCheck({ devices }: { devices: AudioDevice[] }) {
  const { t } = useManagementLocale()
  const [output, setOutput] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AudioPairCheckResult | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const available = devices.some(d => d.id === output && d.output) && devices.some(d => d.id === input && d.input) && output !== input
  async function check() {
    if (busy || !available) return
    setBusy(true); setResult(null); setError('')
    try {
      const { data } = await api.checkAudioPair(output, input)
      if (!data || typeof data.passed !== 'boolean') throw new Error(t('audioPair.incomplete'))
      if (mounted.current) setResult(data)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('audioPair.failed'))
    } finally { if (mounted.current) setBusy(false) }
  }
  function change(set: (value: string) => void, value: string) { set(value); setResult(null); setError('') }
  return <section aria-label={t('audioPair.title')} className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
    <div><h4 className="text-sm font-medium">{t('audioPair.title')}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('audioPair.description')}</p></div>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="pair-check-output">{t('audioPair.output')}</Label><Select id="pair-check-output" value={output} onChange={e => change(setOutput, e.target.value)}><option value="">{t('audioPair.selectOutput')}</option>{devices.filter(d => d.output).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="pair-check-input">{t('audioPair.input')}</Label><Select id="pair-check-input" value={input} onChange={e => change(setInput, e.target.value)}><option value="">{t('audioPair.selectInput')}</option>{devices.filter(d => d.input).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div>
    </fieldset>
    <Button variant="outline" disabled={busy || !available} onClick={check}>{busy ? t('audioPair.checking') : t('audioPair.check')}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div role="status" className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
      <p className={result.passed ? 'text-emerald-400' : 'text-amber-300'}>{result.passed ? t('audioPair.passed') : t('audioPair.notPassed')}</p>
      <p className="text-xs text-muted-foreground">{t('audioPair.amplitude')} {result.tone_amplitude.toFixed(4)} · {t('audioPair.sampled')} {(result.captured_frames / 48000).toFixed(1)} {t('audioPair.seconds')}</p>
      <p className="text-xs text-muted-foreground">{t('audioPair.resultHint')}</p>
    </div>}
  </section>
}
