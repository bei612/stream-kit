import { useState } from 'react'
import { useConfigurationDraft } from '@/hooks/useConfigurationDraft'
import { api } from '@/api/client'
import type { AudioDevice } from '@/api/audio-devices'
import type { AudioTarget, RenderSession } from '@/api/sessions'
import { Button } from '@/components/ui/button'

export function AudioTargetSettings({ session, busy, action }: {
  session: RenderSession
  busy: boolean
  action: (operation: () => Promise<unknown>) => Promise<void>
}) {
  const targetDraft = useConfigurationDraft(session.audio.target, (a, b) => a.epoch === b.epoch && a.mode === b.mode && a.render_device_id === b.render_device_id && a.capture_device_id === b.capture_device_id)
  const {value: draft, dirty, stale} = targetDraft
  const [devices, setDevices] = useState<AudioDevice[] | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const edit = (values: Partial<AudioTarget>) => targetDraft.edit({ ...draft, ...values })
  async function readDevices() {
    setReading(true); setError(''); setDevices(null)
    try { setDevices((await api.getAudioDevices()).data?.devices ?? []) }
    catch (error) { setError(error instanceof Error ? error.message : '无法读取音频设备') }
    finally { setReading(false) }
  }
  const selection = (direction: 'output' | 'input', field: 'render_device_id' | 'capture_device_id', label: string) =>
    <label className="block min-w-0 space-y-1 text-sm">
      <span>{label}</span>
      <select aria-label={label} className="w-full min-w-0 rounded-md border border-border bg-background p-2" required value={draft[field]} onChange={e => edit({[field]:e.target.value})}>
        <option value="">请选择设备</option>
        {draft[field] && !devices?.some(device => device.id === draft[field] && device[direction]) && <option value={draft[field]}>已保存的设备（请刷新确认）</option>}
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
      <legend className="mb-2 flex flex-wrap items-center gap-2 font-medium">目标程序麦克风<span className="rounded bg-primary/10 px-2 py-1 text-xs font-normal text-primary">实时应用 · 无需重启网关</span></legend>
      <label className="block max-w-sm space-y-1 text-sm"><span>发送方式</span>
        <select aria-label="发送方式" className="w-full rounded-md border border-border bg-background p-2" value={draft.mode} onChange={e => {
          const mode = e.target.value as AudioTarget['mode']
          edit({mode,...(mode === 'local' ? {} : {render_device_id:'',capture_device_id:''})})
        }}>
          <option value="upstream">上游原生麦克风通道</option>
          <option value="local">服务器虚拟音频端点</option>
          <option value="disabled">关闭目标程序麦克风</option>
        </select>
      </label>
      {draft.mode === 'local' && <>
        <p className="text-xs leading-relaxed text-muted-foreground">适用于网关与目标程序位于同一节点。请选择已部署的虚拟音频配对端点，并在目标程序中选择对应输入；任意两个物理设备不能建立音频连线。</p>
        <Button type="button" size="sm" variant="outline" disabled={reading} onClick={readDevices}>{reading ? '正在读取…' : '刷新音频设备'}</Button>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          {selection('output','render_device_id','网关写入端 · 输出设备')}
          {selection('input','capture_device_id','目标程序读取端 · 输入设备')}
        </div>
      </>}
      {draft.mode === 'upstream' && <p className="text-xs text-muted-foreground">需要上游实际支持麦克风扩展。不支持时，客户端之间仍可广播语音，但目标程序不会收到。</p>}
      {draft.mode === 'disabled' && <p className="text-xs text-muted-foreground">停止向目标程序发送麦克风；客户端语音广播仍由上方广播设置控制。</p>}
      {stale && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">配置已在其他页面更新，请重新载入后编辑。
        <Button type="button" size="sm" variant="outline" onClick={targetDraft.reset}>载入最新配置</Button>
      </div>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={stale || reading}>{dirty ? '保存并应用目标' : '重新应用目标'}</Button>
        <span className="text-xs text-muted-foreground">保存后以网关运行反馈确认生效；重新应用可重试失效设备。</span>
      </div>
    </fieldset>
  </form>
}
