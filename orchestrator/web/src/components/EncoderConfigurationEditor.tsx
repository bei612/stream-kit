import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import type { ConfigValue, EncoderConfigurationView } from '@/api/configuration'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label, Select } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'

const labels:Record<string,string>={sunshine_name:'渲染节点名称',capture:'画面采集方式',encoder:'编码器',adapter_name:'显卡',output_name:'显示输出',audio_sink:'主机声音设备',virtual_sink:'虚拟声音设备',stream_audio:'传输主机声音',max_bitrate:'最大码率',mouse:'鼠标输入',keyboard:'键盘输入',controller:'手柄输入',native_pen_touch:'原生触控与笔输入',min_log_level:'日志级别'}
type Draft={mode:'text'|'json'|'reset';text:string}

export function EncoderConfigurationEditor() {
  const [view,setView]=useState<EncoderConfigurationView|null>(null)
  const [drafts,setDrafts]=useState<Record<string,Draft>>({})
  const [busy,setBusy]=useState(false),[reloadRequired,setReloadRequired]=useState(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[newKey,setNewKey]=useState('')
  async function load() {
    setBusy(true);setError('');setNotice('')
    try {
      const {data}=await api.getEncoderConfiguration()
      if(!data?.values||!/^"[a-f0-9]{64}"$/i.test(data.revision)||data.apply_policy!=='encoder_restart'||!Array.isArray(data.redacted_keys))throw new Error('编码器未返回有效配置版本。')
      setView(data);setDrafts({});setReloadRequired(false);setNewKey('')
    } catch(e) {setReloadRequired(true);setError(e instanceof Error?e.message:'无法读取编码器配置')}
    finally {setBusy(false)}
  }
  useEffect(()=>{void load()},[])
  function edit(key:string,draft:Draft) {setDrafts(current=>({...current,[key]:draft}));setNotice('')}
  async function save() {
    if(!view||busy||reloadRequired)return
    setError('');setNotice('')
    const changes:Record<string,ConfigValue>=Object.create(null)
    try {
      for(const [key,draft] of Object.entries(drafts)) {
        changes[key]=draft.mode==='reset'?null:draft.mode==='json'?JSON.parse(draft.text):draft.text
        if(typeof changes[key]==='string'&&/[\r\n\0]/.test(changes[key] as string))throw new Error('文本参数不能包含换行或空字符。')
      }
    }catch(e){setError(e instanceof SyntaxError?'结构化参数必须使用有效 JSON。':e instanceof Error?e.message:'配置格式无效');return}
    setBusy(true)
    try {
      const {data}=await api.saveEncoderConfiguration(view.revision,changes)
      if(!data||!/^"[a-f0-9]{64}"$/i.test(data.revision)||data.apply_policy!=='encoder_restart'||data.runtime_verified!==false)throw new Error('保存确认不完整，请重新读取。')
      // Reload before another transaction; native normalization may omit overrides.
      setReloadRequired(true);setDrafts({})
      setNotice('配置已保存，需重启编码器后生效。尚未核验运行版本；继续编辑前请重新读取。')
    }catch(e){setReloadRequired(true);setError(e instanceof Error?e.message:'保存未确认，请重新读取后再操作')}
    finally{setBusy(false)}
  }
  const keys=[...new Set([...Object.keys(view?.values||{}),...Object.keys(drafts)])].sort()
  return <Card>
    <CardHeader><CardTitle>渲染编码器配置</CardTitle><p className="text-sm text-muted-foreground">管理画面、声音与输入的原生参数。以下配置均在编码器重启后生效；控制权和会话音量在会话页面实时调整。</p></CardHeader>
    <CardContent className="space-y-4">
      <Alert variant="warning">此处显示文件中的显式配置，未设置项使用编码器默认值。当前尚未提供运行版本确认。</Alert>
      {error&&<Alert variant="error" role="alert">{error}</Alert>}
      {notice&&<Alert variant="success" role="status">{notice}</Alert>}
      <fieldset disabled={busy||reloadRequired} className="space-y-3 min-w-0">
        {keys.map(key=>{
          const draft=Object.hasOwn(drafts,key)?drafts[key]:undefined,hidden=view?.redacted_keys.includes(key)
          const original=view?.values[key]
          const mode=draft?.mode??(typeof original==='string'||hidden?'text':'json')
          const text=draft?.text??(hidden?'':typeof original==='string'?original:JSON.stringify(original)??'')
          const id='encoder-setting-'+key
          return <div key={key} className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <Label htmlFor={id}>{labels[key]||key}<span className="ml-2 text-xs text-muted-foreground">重启生效</span></Label>
            <p className="text-xs text-muted-foreground break-all">{key}</p>
            <Select aria-label={`${key} 编辑方式`} value={mode} onChange={e=>edit(key,{mode:e.target.value as Draft['mode'],text})}><option value="text">文本值</option><option value="json">结构化 JSON 值</option><option value="reset">恢复默认（删除覆盖）</option></Select>
            {mode==='reset'?<p className="text-sm text-amber-400">保存后删除此项配置覆盖。</p>:<Input id={id} type={hidden?'password':'text'} autoComplete="off" value={text} placeholder={hidden?'值已隐藏，未编辑则保留':''} onChange={e=>edit(key,{mode,text:e.target.value})}/>}
            {draft&&<Button size="sm" variant="ghost" onClick={()=>setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([name])=>name!==key)))}>撤销此项修改</Button>}
          </div>
        })}
        {view&&<div className="rounded-lg border border-border p-3 space-y-2">
          <Label htmlFor="encoder-new-key">添加原生参数</Label>
          <p className="text-xs text-muted-foreground">使用编码器支持的参数名。完整参数目录与范围校验尚未接入。</p>
          <div className="flex gap-2"><Input id="encoder-new-key" value={newKey} onChange={e=>setNewKey(e.target.value)} placeholder="例如 sunshine_name"/><Button variant="outline" disabled={!/^[a-zA-Z0-9_]{1,128}$/.test(newKey)||['status','platform','version','__proto__','constructor','prototype'].includes(newKey)||keys.includes(newKey)} onClick={()=>{edit(newKey,{mode:'text',text:''});setNewKey('')}}>添加</Button></div>
        </div>}
      </fieldset>
      <div className="flex flex-wrap gap-3"><Button onClick={save} disabled={!view||busy||reloadRequired||!Object.keys(drafts).length}>保存编码器配置</Button><Button variant="outline" onClick={load} disabled={busy}>{Object.keys(drafts).length?'放弃编码器修改并重新读取':'重新读取编码器配置'}</Button></div>
    </CardContent>
  </Card>
}
