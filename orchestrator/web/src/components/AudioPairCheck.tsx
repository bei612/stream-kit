import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { AudioDevice, AudioPairCheckResult } from '@/api/audio-devices'
import { Button } from '@/components/ui/button'
import { Select, Label } from '@/components/ui/input'

export function AudioPairCheck({ devices }: { devices: AudioDevice[] }) {
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
      if (!data || typeof data.passed !== 'boolean') throw new Error('检查结果不完整，请重试')
      if (mounted.current) setResult(data)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '无法完成端点检查')
    } finally { if (mounted.current) setBusy(false) }
  }
  function change(set: (value: string) => void, value: string) { set(value); setResult(null); setError('') }
  return <section aria-label="音频端点对检查" className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
    <div><h4 className="text-sm font-medium">检查虚拟音频设备配对</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">在所选输出播放测试音，并短暂读取所选输入。请先停止占用这对设备的串流；检查不会修改默认设备或保存录音。</p></div>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="pair-check-output">测试音输出</Label><Select id="pair-check-output" value={output} onChange={e => change(setOutput, e.target.value)}><option value="">选择输出设备</option>{devices.filter(d => d.output).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="pair-check-input">配对录音输入</Label><Select id="pair-check-input" value={input} onChange={e => change(setInput, e.target.value)}><option value="">选择输入设备</option>{devices.filter(d => d.input).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div>
    </fieldset>
    <Button variant="outline" disabled={busy || !available} onClick={check}>{busy ? '正在播放与测量…' : '播放测试音并检查'}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div role="status" className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
      <p className={result.passed ? 'text-emerald-400' : 'text-amber-300'}>{result.passed ? '本次端点配对检查通过' : '本次端点配对检查未通过'}</p>
      <p className="text-xs text-muted-foreground">测试音幅度 {result.tone_amplitude.toFixed(4)} · 采样 {(result.captured_frames / 48000).toFixed(1)} 秒</p>
      <p className="text-xs text-muted-foreground">检查结果仅适用于本次设备状态；浏览器麦克风送达及目标程序录音需继续验证。</p>
    </div>}
  </section>
}
