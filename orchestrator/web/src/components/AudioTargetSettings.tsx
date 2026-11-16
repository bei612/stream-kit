import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfigurationDraft } from '@/hooks/useConfigurationDraft'
import { api } from '@/api/client'
import type { AudioDevice } from '@/api/audio-devices'
import type { AudioTarget, RenderSession } from '@/api/sessions'
import { Button } from '@/components/ui/button'
import { ContentGrid } from '@/components/layout/Page'
import { useManagementLocale } from '@/i18n'

export function AudioTargetSettings({ session, busy, action }: {
  session: RenderSession
  busy: boolean
  action: (operation: () => Promise<unknown>) => Promise<void>
}) {
  const { t } = useManagementLocale()
  const targetDraft = useConfigurationDraft(session.audio.target, (a, b) => a.epoch === b.epoch && a.mode === b.mode && a.node_id === b.node_id && a.render_device_id === b.render_device_id && a.capture_device_id === b.capture_device_id)
  const {value: draft, dirty, stale} = targetDraft
  const [devices, setDevices] = useState<AudioDevice[] | null>(null)
  const [nodes, setNodes] = useState<{id:string;name:string}[]>([])
  const generation = useRef(0)
  const nextGeneration = useCallback(() => ++generation.current, [])
  useEffect(() => {
    let active = true
    void api.getRenderNodes().then(result => {
      if (active) setNodes((result.data?.nodes ?? []).filter(node => node.id !== 'primary'))
    }).catch(error => {
      if (active) setError(error instanceof Error ? error.message : t('audioTarget.nodesError'))
    })
    return () => { active = false; nextGeneration() }
  }, [nextGeneration, t])
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  useEffect(()=>{nextGeneration();setDevices(null);setReading(false)},[draft.mode,draft.node_id,nextGeneration])
  const edit = (values: Partial<AudioTarget>) => targetDraft.edit({ ...draft, ...values })
  async function readDevices() {
    const current=nextGeneration()
    setReading(true); setError(''); setDevices(null)
    try { const inventory=draft.mode==='remote' ? (await api.getNodeAudioDevices(draft.node_id || '')).data?.inventory : (await api.getAudioDevices()).data; if(current===generation.current) setDevices(inventory?.devices ?? []) }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : t('audioTarget.devicesError')) }
    finally { if(current===generation.current) setReading(false) }
  }
  const selection = (direction: 'output' | 'input', field: 'render_device_id' | 'capture_device_id', label: string) =>
    <label className="block min-w-0 space-y-1 text-sm">
      <span>{label}</span>
      <select aria-label={label} className="w-full min-w-0 rounded-md border border-border bg-background p-2" required value={draft[field]} onChange={e => edit({[field]:e.target.value})}>
        <option value="">{t('audioTarget.selectDevice')}</option>
        {draft[field] && !devices?.some(device => device.id === draft[field] && device[direction]) && <option value={draft[field]}>{t('audioTarget.savedDevice')}</option>}
        {devices?.filter(device => device[direction]).map(device => <option key={device.id} value={device.id}>{device.name} · {device.id.slice(-12)}</option>)}
      </select>
    </label>

  return <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={e => {
    e.preventDefault()
    void action(async () => {
      const { epoch, ...target } = draft
      const result = await api.updateAudioTarget(session.session_id, epoch, target)
      if (result.data) targetDraft.reset()
    })
  }}>
    <fieldset disabled={busy} className="space-y-3">
      <legend className="mb-2 flex flex-wrap items-center gap-2 font-medium">{t('audioTarget.title')}<span className="rounded bg-primary/10 px-2 py-1 text-xs font-normal text-primary">{t('audioTarget.liveHint')}</span></legend>
      <label className="block max-w-sm space-y-1 text-sm"><span>{t('audioTarget.mode')}</span>
        <select aria-label={t('audioTarget.mode')} className="w-full rounded-md border border-border bg-background p-2" value={draft.mode} onChange={e => {
          const mode = e.target.value as AudioTarget['mode']
          nextGeneration();setDevices(null);setReading(false);setError('')
          edit({mode,node_id:mode==='remote' ? (nodes[0]?.id || '') : undefined,render_device_id:'',capture_device_id:''})
        }}>
          <option value="upstream">{t('audioTarget.upstream')}</option>
          <option value="local">{t('audioTarget.local')}</option>
          <option value="remote">{t('audioTarget.remote')}</option>
          <option value="disabled">{t('audioTarget.disabled')}</option>
        </select>
      </label>
      {draft.mode === 'remote' && <label className="block max-w-sm space-y-1 text-sm">
        <span>{t('audioTarget.renderNode')}</span>
        <select aria-label={t('audioTarget.renderNode')} required className="w-full rounded-md border border-border bg-background p-2" value={draft.node_id || ''} onChange={e => {
          nextGeneration(); setDevices(null); setReading(false); setError('')
          edit({node_id:e.target.value, render_device_id:'', capture_device_id:''})
        }}>
          <option value="">{t('audioTarget.selectNode')}</option>
          {nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select>
        {!nodes.length && <p className="text-xs text-muted-foreground">{t('audioTarget.noNodes')}</p>}
      </label>}
      {(draft.mode === 'local' || draft.mode === 'remote') && <>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('audioTarget.endpointHint')}</p>
        <Button type="button" size="sm" variant="outline" disabled={reading || (draft.mode==='remote' && !draft.node_id)} onClick={readDevices}>{reading ? t('audioTarget.reading') : t('audioTarget.refresh')}</Button>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <ContentGrid variant="fields">
          {selection('output','render_device_id',t('audioTarget.output'))}
          {selection('input','capture_device_id',t('audioTarget.input'))}
        </ContentGrid>
      </>}
      {draft.mode === 'upstream' && <p className="text-xs text-muted-foreground">{t('audioTarget.upstreamHint')}</p>}
      {draft.mode === 'disabled' && <p className="text-xs text-muted-foreground">{t('audioTarget.disabledHint')}</p>}
      {stale && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">{t('audioTarget.stale')}
        <Button type="button" size="sm" variant="outline" onClick={targetDraft.reset}>{t('audioTarget.reload')}</Button>
      </div>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={stale || reading}>{dirty ? t('audioTarget.saveApply') : t('audioTarget.reapply')}</Button>
        <span className="text-xs text-muted-foreground">{t('audioTarget.applyHint')}</span>
      </div>
    </fieldset>
  </form>
}
