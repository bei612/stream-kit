import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { Label, Select } from '@/components/ui/input'
import { useManagementLocale } from '@/i18n'

export type CaptureMode = 'desktop' | 'application'

export default function CaptureModeField({value,onChange,disabled=false}:{value:CaptureMode;onChange:(mode:CaptureMode)=>void;disabled?:boolean}) {
  const { t } = useManagementLocale()
  const [supported,setSupported]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    api.captureCapabilities().then(({data})=>{
      if(active) setSupported(data?.schema_version===1 && data.capture_modes.includes('application'))
    }).catch((e:unknown)=>{
      if(active) setError(e instanceof Error?e.message:t('captureMode.capabilityError'))
    }).finally(()=>{if(active) setLoading(false)})
    return ()=>{active=false}
  },[t])
  return <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Label htmlFor="capture-mode" className="mb-0">{t('captureMode.label')}</Label>
      <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">{t('captureMode.nextLaunch')}</span>
    </div>
    <Select id="capture-mode" value={value} disabled={disabled||loading} onChange={e=>onChange(e.target.value as CaptureMode)} aria-describedby="capture-mode-help">
      <option value="desktop">{t('captureMode.desktop')}</option>
      <option value="application" disabled={!supported}>{t('captureMode.application')}</option>
    </Select>
    <p id="capture-mode-help" className="text-xs leading-relaxed text-muted-foreground">
      {value==='application'?t('captureMode.applicationHelp'):t('captureMode.desktopHelp')}
      {' '}{t('captureMode.stopBeforeChange')}
    </p>
    {(loading||error||!supported)&&<p className="text-xs text-muted-foreground" role="status">{loading?t('captureMode.checking'):error||t('captureMode.unsupported')}</p>}
  </div>
}
