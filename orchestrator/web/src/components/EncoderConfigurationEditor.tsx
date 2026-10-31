import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import type { ConfigValue, EncoderConfigurationView } from '@/api/configuration'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label, Select } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'

type Draft={mode:'text'|'json'|'reset';text:string}

export function EncoderConfigurationEditor() {
  const [view,setView]=useState<EncoderConfigurationView|null>(null)
  const [drafts,setDrafts]=useState<Record<string,Draft>>({})
  const [busy,setBusy]=useState(false),[reloadRequired,setReloadRequired]=useState(false)
  const [canApply,setCanApply]=useState(false)
  const [search,setSearch]=useState('')
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[newKey,setNewKey]=useState('')
  async function load() {
    setBusy(true);setError('');setNotice('')
    try {
      const [{data},component]=await Promise.all([api.getEncoderConfiguration(),api.getComponent('sunshine').catch(()=>null)])
      if(!data?.values||!/^"[a-f0-9]{64}"$/i.test(data.revision)||data.apply_policy!=='encoder_restart'||!Array.isArray(data.redacted_keys))throw new Error('编码器未返回有效配置版本。')
      setView(data);setDrafts({});setReloadRequired(false);setNewKey('')
      setCanApply(!!data.managed_instance_id&&data.process_id===component?.data?.pid)
    } catch(e) {setReloadRequired(true);setError(e instanceof Error?e.message:'无法读取编码器配置')}
    finally {setBusy(false)}
  }
  useEffect(()=>{void load()},[])
  async function apply() {
    if(!view?.instance_id||!canApply||busy||reloadRequired||Object.keys(drafts).length)return
    setBusy(true);setError('');setNotice('')
    try {
      const {data}=await api.applyEncoderConfiguration(view.revision,view.instance_id)
      if(!data||data.restart_required||data.loaded_revision!==view.revision||data.revision!==view.revision||data.instance_id===view.instance_id)throw new Error('尚未确认新编码器实例加载了目标配置，请重新读取。')
      setView({...view,...data})
      setNotice('编码器已重启，新实例已读取目标配置文件。命令行覆盖项仍有效。')
    }catch(e){setReloadRequired(true);setError(e instanceof Error?e.message:'配置应用未确认，请重新读取')}
    finally{setBusy(false)}
  }
  function edit(key:string,draft:Draft) {setDrafts(current=>({...current,[key]:draft}));setNotice('')}
  async function save() {
    if(!view||busy||reloadRequired)return
    setError('');setNotice('')
    const changes:Record<string,ConfigValue>=Object.create(null)
    try {
      for(const [key,draft] of Object.entries(drafts)) {
        changes[key]=draft.mode==='reset'?null:draft.mode==='json'?JSON.parse(draft.text):draft.text
        if(typeof changes[key]==='string'&&/[\r\n\0]/.test(changes[key] as string))throw new Error('文本参数不能包含换行或空字符。')
        const field=view.fields?.find(field=>field.key===key),value=changes[key]
        if(field&&value!==null&&value!=='') {
          if(field.type==='string'&&typeof value!=='string')throw new Error(`${field.label}必须使用文本值。`)
          if(field.choices?.length&&!field.choices.includes(String(value)))throw new Error(`${field.label}请选择支持的值。`)
          if(field.type==='integer') {
            const text=String(value),number=Number(text)
            if((typeof value!=='string'&&typeof value!=='number')||!/^[+-]?\d+$/.test(text)||!Number.isSafeInteger(number)||number<(field.minimum??0)||(field.maximum!==undefined&&number>field.maximum))throw new Error(`${field.label}必须为 ${field.minimum??0} 至 ${field.maximum??'允许上限'} 范围内的整数。`)
          }
          if(field.type==='number') {
            const text=String(value),number=Number(text)
            if((typeof value!=='string'&&typeof value!=='number')||!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)||!Number.isFinite(number)||number<(field.minimum??0)||(field.maximum!==undefined&&number>field.maximum))throw new Error(`${field.label}必须为 ${field.minimum??0} 至 ${field.maximum??'允许上限'} 范围内的数值。`)
          }
        }
      }
    }catch(e){setError(e instanceof SyntaxError?'结构化参数必须使用有效 JSON。':e instanceof Error?e.message:'配置格式无效');return}
    setBusy(true)
    try {
      const {data}=await api.saveEncoderConfiguration(view.revision,changes)
      if(!data||!/^"[a-f0-9]{64}"$/i.test(data.revision)||data.apply_policy!=='encoder_restart'||data.runtime_verified!==false)throw new Error('保存确认不完整，请重新读取。')
      // Reload before another transaction; native normalization may omit overrides.
      setView({...view,revision:data.revision,restart_required:view.loaded_revision?view.loaded_revision!==data.revision:undefined})
      setReloadRequired(true);setDrafts({})
      setNotice('配置已保存，需重启编码器后生效。尚未核验运行版本；继续编辑前请重新读取。')
    }catch(e){setReloadRequired(true);setError(e instanceof Error?e.message:'保存未确认，请重新读取后再操作')}
    finally{setBusy(false)}
  }
  const keys=[...new Set([...Object.keys(view?.values||{}),...Object.keys(drafts)])].sort()
  const fields=new Map((view?.fields||[]).map(field=>[field.key,field]))
  const query=search.trim().toLocaleLowerCase()
  const matches=(key:string)=>!query||`${key} ${fields.get(key)?.label||''}`.toLocaleLowerCase().includes(query)
  const visibleKeys=keys.filter(matches)
  const availableFields=(view?.fields||[]).filter(field=>!keys.includes(field.key)&&matches(field.key))
  return <Card>
    <CardHeader><CardTitle>渲染编码器配置</CardTitle><p className="text-sm text-muted-foreground">管理画面、声音与输入的原生参数。以下配置均在编码器重启后生效；控制权和会话音量在会话页面实时调整。</p></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">此处显示文件中的显式配置，未设置项使用编码器默认值。</p>
      {view?.loaded_revision?<div className="rounded-lg border border-border p-3 space-y-2 text-xs text-muted-foreground">
        <p className="break-all">启动读取版本：<code>{view.loaded_revision}</code></p>
        <p role="status" className={view.restart_required?'text-amber-400':'text-emerald-400'}>{view.restart_required?'配置文件已变化，需重启编码器加载。':'当前进程启动时已读取此配置文件版本。'}</p>
        <p>文件版本一致不代表所有参数均被接受；启动覆盖与平台支持仍影响实际行为。</p>
        {!!view.overridden_keys?.length&&<p>启动参数覆盖：{view.overridden_keys.join('、')}</p>}
      </div>:<Alert variant="warning">尚未取得编码器启动配置版本。</Alert>}
      {error&&<Alert variant="error" role="alert">{error}</Alert>}
      {notice&&<Alert variant="success" role="status">{notice}</Alert>}
      {view&&<div className="space-y-2">
        <Label htmlFor="encoder-search">搜索编码器参数</Label>
        <Input id="encoder-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入参数名称或说明"/>
        <p className="text-xs text-muted-foreground">显示 {visibleKeys.length} / {keys.length} 个配置项，{availableFields.length} 个可添加参数。搜索不会清除未保存修改。</p>
      </div>}
      {canApply&&view?.restart_required&&<div className="rounded-lg border border-border p-3 space-y-2">
        <p className="text-sm text-muted-foreground">重启会中断当前渲染和观看连接。监听地址、证书或凭据变更需同步调整连接配置；失败不会自动回滚。</p>
        <Button variant="outline" onClick={apply} disabled={busy||reloadRequired||!!Object.keys(drafts).length}>重启编码器并加载配置</Button>
        {(reloadRequired||!!Object.keys(drafts).length)&&<p className="text-xs text-muted-foreground">请先保存或撤销编辑，并重新读取已保存配置。</p>}
      </div>}
      <fieldset disabled={busy||reloadRequired} className="space-y-3 min-w-0">
        {visibleKeys.map(key=>{
          const draft=Object.hasOwn(drafts,key)?drafts[key]:undefined,hidden=view?.redacted_keys.includes(key)
          const original=view?.values[key]
          const field=fields.get(key)
          const mode=draft?.mode??(typeof original==='string'||hidden?'text':'json')
          const text=draft?.text??(hidden?'':typeof original==='string'?original:JSON.stringify(original)??'')
          const id='encoder-setting-'+key
          return <div key={key} className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <Label htmlFor={id}>{field?.label||key}<span className="ml-2 text-xs text-muted-foreground">重启生效</span></Label>
            <p className="text-xs text-muted-foreground break-all">{key}</p>
            <Select aria-label={`${key} 编辑方式`} value={mode} onChange={e=>edit(key,{mode:e.target.value as Draft['mode'],text})}><option value="text">文本值</option><option value="json">结构化 JSON 值</option><option value="reset">恢复默认（删除覆盖）</option></Select>
            {mode==='reset'?<p className="text-sm text-amber-400">保存后删除此项配置覆盖。</p>:field?.type==='boolean'?<Select id={id} value={text} onChange={e=>edit(key,{mode:'json',text:e.target.value})}>
              {!['true','false'].includes(text)&&<option value={text}>{text||'未设置'}</option>}<option value="true">开启</option><option value="false">关闭</option>
            </Select>:field?.choices?.length?<Select id={id} value={text} onChange={e=>edit(key,{mode:'text',text:e.target.value})}>
              {!field.choices.includes(text)&&<option value={text}>{text||'未设置'}</option>}{field.choices.map(value=><option key={value} value={value}>{value}</option>)}
            </Select>:<Input id={id} type={hidden?'password':field?.type==='integer'||field?.type==='number'?'number':'text'} min={field?.type==='integer'||field?.type==='number'?(field.minimum??0):undefined} max={field?.maximum} step={field?.type==='integer'?1:field?.type==='number'?'any':undefined} autoComplete="off" value={text} placeholder={hidden?'值已隐藏，未编辑则保留':''} onChange={e=>edit(key,{mode,text:e.target.value})}/>}
            {draft&&<Button size="sm" variant="ghost" onClick={()=>setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([name])=>name!==key)))}>撤销此项修改</Button>}
          </div>
        })}
        {view&&<div className="rounded-lg border border-border p-3 space-y-2">
          <Label htmlFor="encoder-new-key">添加原生参数</Label>
          {!!view.fields?.length&&<Select aria-label="选择常用编码参数" value="" onChange={e=>{if(e.target.value)edit(e.target.value,{mode:'text',text:''})}}><option value="">选择尚未配置的常用参数</option>{availableFields.map(field=><option key={field.key} value={field.key}>{field.label} · {field.key}</option>)}</Select>}
          <p className="text-xs text-muted-foreground">常用参数由服务端校验类型。其他原生参数可按名称添加；平台支持和完整参数范围仍以编码器为准。</p>
          <div className="flex gap-2"><Input id="encoder-new-key" value={newKey} onChange={e=>setNewKey(e.target.value)} placeholder="例如 sunshine_name"/><Button variant="outline" disabled={!/^[a-zA-Z0-9_]{1,128}$/.test(newKey)||['status','platform','version','__proto__','constructor','prototype'].includes(newKey)||keys.includes(newKey)} onClick={()=>{edit(newKey,{mode:'text',text:''});setNewKey('')}}>添加</Button></div>
        </div>}
      </fieldset>
      <div className="flex flex-wrap gap-3"><Button onClick={save} disabled={!view||busy||reloadRequired||!Object.keys(drafts).length}>保存编码器配置</Button><Button variant="outline" onClick={load} disabled={busy}>{Object.keys(drafts).length?'放弃编码器修改并重新读取':'重新读取编码器配置'}</Button></div>
    </CardContent>
  </Card>
}
