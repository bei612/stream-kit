import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { AudioInventory } from '@/api/audio-devices'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Select, Label } from '@/components/ui/input'

export function RenderNodes(){
  const [nodes,setNodes]=useState<{id:string,name:string,base_url:string}[]>([])
  const [selected,setSelected]=useState('')
  const [inventory,setInventory]=useState<AudioInventory|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const generation=useRef(0)
  useEffect(()=>{const current=++generation.current;api.getRenderNodes().then(result=>{
    if(current!==generation.current)return
    setNodes(result.data?.nodes||[]);setSelected(result.data?.nodes[0]?.id||'')
  }).catch(error=>{if(current===generation.current)setError(error instanceof Error?error.message:'无法读取节点')});return()=>{generation.current++}},[])
  async function inspect(){
    if(!selected||busy)return
    const current=++generation.current,id=selected
    setBusy(true);setError('');setInventory(null)
    try{const result=await api.getNodeAudioDevices(id);if(current!==generation.current)return
      if(result.data?.node_id!==id)throw new Error('节点设备响应不匹配')
      setInventory(result.data.inventory)
    }catch(error){if(current===generation.current)setError(error instanceof Error?error.message:'无法读取节点设备')}
    finally{if(current===generation.current)setBusy(false)}
  }
  return <Card><CardHeader><CardTitle>渲染节点</CardTitle><p className="text-sm text-muted-foreground">查看当前已生效的节点连接。新增或修改节点连接后需重启管理服务；读取目录不会开启录音。</p></CardHeader>
    <CardContent className="space-y-3">
      {error&&<Alert variant="error" role="alert">{error}</Alert>}
      {!nodes.length?<p className="text-sm text-muted-foreground">尚无已生效节点，请先配置节点连接。</p>:<>
        <Label htmlFor="render-node-selection">节点</Label>
        <Select id="render-node-selection" value={selected} disabled={busy} onChange={event=>{generation.current++;setSelected(event.target.value);setInventory(null);setError('')}}>
          {nodes.map(node=><option key={node.id} value={node.id}>{node.name} · {node.id}</option>)}
        </Select>
        <p className="break-all text-xs text-muted-foreground">{nodes.find(node=>node.id===selected)?.base_url}</p>
        <Button variant="outline" onClick={inspect} disabled={busy}>{busy?'正在验证节点…':'读取节点设备'}</Button>
        {inventory&&<div className="space-y-2" aria-label="节点音频设备">
          <p className="text-xs text-muted-foreground">已验证设备目录。设备可见不代表目标程序已收到麦克风声音。</p>
          {!inventory.devices.length&&<p className="text-sm">节点当前没有可见音频设备。</p>}
          {inventory.devices.map(device=><div key={device.id} className="rounded-lg border border-border p-3"><p className="text-sm font-medium">{device.name}</p><p className="text-xs text-muted-foreground">{[device.input&&'录音输入',device.output&&'播放输出'].filter(Boolean).join(' / ')}</p><code className="block break-all text-xs text-muted-foreground">{device.id}</code></div>)}
        </div>}
      </>}
    </CardContent></Card>
}
