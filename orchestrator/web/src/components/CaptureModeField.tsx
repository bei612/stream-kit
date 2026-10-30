import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { Label, Select } from '@/components/ui/input'

export type CaptureMode = 'desktop' | 'application'

export default function CaptureModeField({value,onChange,disabled=false}:{value:CaptureMode;onChange:(mode:CaptureMode)=>void;disabled?:boolean}) {
  const [supported,setSupported]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    api.captureCapabilities().then(({data})=>{
      if(active) setSupported(data?.schema_version===1 && data.capture_modes.includes('application'))
    }).catch((e:unknown)=>{
      if(active) setError(e instanceof Error?e.message:'无法读取服务器采集能力')
    }).finally(()=>{if(active) setLoading(false)})
    return ()=>{active=false}
  },[])
  return <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Label htmlFor="capture-mode" className="mb-0">画面与声音范围</Label>
      <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">下次启动应用生效</span>
    </div>
    <Select id="capture-mode" value={value} disabled={disabled||loading} onChange={e=>onChange(e.target.value as CaptureMode)} aria-describedby="capture-mode-help">
      <option value="desktop">整个桌面与系统声音</option>
      <option value="application" disabled={!supported}>指定程序窗口与程序声音</option>
    </Select>
    <p id="capture-mode-help" className="text-xs leading-relaxed text-muted-foreground">
      {value==='application'?'采集此应用的主窗口和进程树声音。窗口关闭或采集失败时停止输出，不切换到桌面。':'采集所选显示器画面和系统播放声音，可能包含其他程序的内容。'}
      {' '}修改前需停止应用串流。
    </p>
    {(loading||error||!supported)&&<p className="text-xs text-muted-foreground" role="status">{loading?'正在核对服务器采集能力…':error||'当前编码器版本或服务器平台尚未提供指定程序采集。'}</p>}
  </div>
}
