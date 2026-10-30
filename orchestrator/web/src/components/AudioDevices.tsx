import { useEffect, useRef, useState } from 'react'
import { AudioLines, RefreshCw } from 'lucide-react'
import { api } from '@/api/client'
import type { AudioInventory } from '@/api/audio-devices'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function AudioDevices() {
  const [inventory, setInventory] = useState<AudioInventory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function refresh() {
    setBusy(true)
    setError('')
    setInventory(null)
    try {
      const result = await api.getAudioDevices()
      if (mounted.current) setInventory(result.data ?? null)
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : '无法读取音频设备')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function endpoint(id: string, direction: 'input' | 'output') {
    const device = inventory?.devices.find(device => device.id === id)
    return <div className="min-w-0 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{direction === 'output' ? '网关写入端 · 输出设备' : '目标程序读取端 · 输入设备'}</p>
      <p className="mt-1 break-words text-sm font-medium">{device?.name || '设备当前不可见'}</p>
      {device && !device[direction] && <p className="mt-1 text-xs text-amber-300">设备方向与绑定不匹配</p>}
      <code className="mt-2 block break-all text-xs text-muted-foreground">{id}</code>
    </div>
  }

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle><span className="flex items-center gap-2"><AudioLines className="h-4 w-4 text-primary" />服务器音频设备</span></CardTitle>
        <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
          <RefreshCw className="h-4 w-4" />{busy ? '正在读取…' : inventory ? '刷新设备' : '读取设备'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">读取媒体网关所在服务器的设备及当前绑定。目标程序需选择配对虚拟音频设备的输入端。</p>
    </CardHeader>
    <CardContent className="space-y-4" aria-busy={busy}>
      {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-red-300">{error}</p>}
      {!inventory && !error && <p role="status" className="text-sm text-muted-foreground">{busy ? '正在读取服务器设备目录…' : '点击读取设备，查看当前可用端点。此操作不修改系统音频设置。'}</p>}
      {inventory && <>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{inventory.devices.length} 个设备 · {inventory.configured_routes.length} 个应用绑定</span>
          <span>读取于 {new Date(inventory.observed_at_ms).toLocaleTimeString()}</span>
        </div>
        <section aria-label="应用音频绑定" className="space-y-3">
          <h4 className="text-sm font-medium">应用音频绑定</h4>
          {!inventory.configured_routes.length && <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">尚未配置本机音频绑定。客户端之间的麦克风广播不代表声音已送入目标程序。</p>}
          {inventory.configured_routes.map(route => <div key={`${route.host_id}:${route.app_id}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">主机 {route.host_id} / 应用 {route.app_id}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {endpoint(route.endpoint.render_device_id, 'output')}
              {endpoint(route.endpoint.capture_device_id, 'input')}
            </div>
          </div>)}
        </section>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">全部设备与标识 ({inventory.devices.length})</summary>
          {!inventory.devices.length && <p className="mt-3 text-sm text-muted-foreground">网关当前运行身份下未发现音频设备。</p>}
          <ul className="mt-3 divide-y divide-border">
            {inventory.devices.map(device => <li key={device.id} className="min-w-0 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="min-w-0 break-words">{device.name}</span>
                <span className="text-xs text-muted-foreground">{[device.output && '输出', device.input && '输入'].filter(Boolean).join(' / ') || '不可用'}</span>
              </div>
              <code className="mt-1 block break-all text-xs text-muted-foreground">{device.id}</code>
            </li>)}
          </ul>
        </details>
        <p className="text-xs leading-relaxed text-muted-foreground">设备目录反映本次读取结果。应用绑定目前由网关配置加载；设备存在不代表已配对或已录音，实际接收需在目标程序中验证。</p>
      </>}
    </CardContent>
  </Card>
}
