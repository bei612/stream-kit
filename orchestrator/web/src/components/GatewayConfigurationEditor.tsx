import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import type { ConfigValue, GatewayConfigurationView } from '@/api/configuration'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label, Select, Textarea } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'

const labels:Record<string,string> = {
  data_storage:'网关存储',webrtc:'网络与 WebRTC',web_server:'访问与信任',moonlight:'渲染主机连接',log:'网关日志',local_audio_targets:'独立模式音频路由',
  path:'存储路径',type:'存储类型',session_expiration_check_interval:'过期会话清理周期',secs:'秒',nanos:'纳秒',
  ice_servers:'STUN / TURN 服务',ice_server_script:'动态 ICE 脚本',port_range:'媒体 UDP 端口范围',nat_1to1:'NAT 地址映射',include_loopback_candidates:'允许回环网络候选',urls:'服务地址（每行一项）',username:'用户名',credential:'访问凭据',
  bind_address:'监听地址',certificate:'TLS 证书与私钥路径',url_path_prefix:'访问路径前缀',session_cookie_secure:'仅通过 HTTPS 发送会话 Cookie',session_cookie_expiration:'会话有效期',first_login_create_admin:'首次登录创建网关管理员',first_login_assign_global_hosts:'首次登录关联已有主机',forwarded_header:'代理身份请求头',media_ticket_secret:'媒体信任密钥',control_plane_url:'控制面访问地址',
  default_http_port:'渲染主机 HTTP 端口',pair_device_name:'配对设备名称',level_filter:'日志级别',file_path:'日志文件路径',dev_venator:'开发调试输出',
  min:'起始端口',max:'结束端口',ips:'映射 IP 地址（每行一项）',ice_candidate_type:'候选类型',host_id:'主机 ID',app_id:'应用 ID',endpoint:'音频端点',render_device_id:'播放端点',capture_device_id:'录音端点',private_key_pem:'私钥路径',certificate_pem:'证书路径',username_header:'用户名请求头',auto_create_missing_user:'自动创建缺失身份',ignore_case:'忽略用户名大小写',
}
const pointer=(key:string)=>key.replaceAll('~','~0').replaceAll('/','~1')
type Kind='string'|'number'|'boolean'|'lines'|'json'
type Draft={text:string;kind:Kind}
const nullableStrings=new Set(['ice_server_script','media_ticket_secret','file_path'])
const examples:Record<string,string>={port_range:'{"min": 50000, "max": 50100}',nat_1to1:'{"ips": ["203.0.113.10"], "ice_candidate_type": "host"}',certificate:'{"certificate_pem": "certs/server.pem", "private_key_pem": "certs/server-key.pem"}',forwarded_header:'{"username_header": "X-Forwarded-User", "auto_create_missing_user": false, "ignore_case": false}'}
type ObjectField={key:string;kind:Exclude<Kind,'json'>;initial:ConfigValue;options?:string[]}
const objects:Record<string,ObjectField[]>={
  '/webrtc/port_range':[{key:'min',kind:'number',initial:50000},{key:'max',kind:'number',initial:50100}],
  '/webrtc/nat_1to1':[{key:'ips',kind:'lines',initial:[]},{key:'ice_candidate_type',kind:'string',initial:'host',options:['host','srflx']}],
  '/web_server/certificate':[{key:'certificate_pem',kind:'string',initial:''},{key:'private_key_pem',kind:'string',initial:''}],
  '/web_server/forwarded_header':[{key:'username_header',kind:'string',initial:'X-Forwarded-User'},{key:'auto_create_missing_user',kind:'boolean',initial:false},{key:'ignore_case',kind:'boolean',initial:false}],
}

export function GatewayConfigurationEditor() {
  const [view,setView]=useState<GatewayConfigurationView|null>(null)
  const [drafts,setDrafts]=useState<Record<string,Draft>>({})
  const [replacements,setReplacements]=useState<Record<string,boolean>>({})
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  async function load() {
    setBusy(true);setError('');setNotice('')
    try {
      const response=await api.getGatewayConfiguration()
      if(!response.data?.values || response.data.apply_policy!=='gateway_restart') throw new Error('网关未返回有效配置，请检查连接与版本。')
      setView(response.data);setDrafts({});setReplacements({})
    } catch(e) {setError(e instanceof Error?e.message:'无法读取网关配置')}
    finally {setBusy(false)}
  }
  useEffect(()=>{void load()},[])
  const edit=(path:string,text:string,kind:Kind)=>{
    setDrafts(current=>({...Object.fromEntries(Object.entries(current).filter(([p])=>!p.startsWith(path+'/'))),[path]:{text,kind}}));setNotice('');setError('')
  }
  const undo=(path:string)=>{setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([p])=>p!==path&&!p.startsWith(path+'/'))));setReplacements(current=>({...current,[path]:false}));setError('')}
  function optionalObject(value:ConfigValue,path:string,key:string,fields:ObjectField[]) {
    const parentDraft=drafts[path]
    const current:ConfigValue=parentDraft?JSON.parse(parentDraft.text):value
    const hidden=view?.redacted_paths.includes(path)
    const enabled=current!==null||(!parentDraft&&hidden)
    const currentObject=current!==null&&typeof current==='object'&&!Array.isArray(current)?current:{}
    const changed=Object.keys(drafts).some(p=>p===path||p.startsWith(path+'/'))
    const overridden=view?.overridden_paths.some(p=>p===path||p.startsWith(path+'/'))
    const id='gateway-setting'+path
    const update=(descriptor:ObjectField,text:string)=>{
      if(parentDraft) {
        const next:ConfigValue=descriptor.kind==='boolean'?text==='true':descriptor.kind==='lines'?text.split('\n').map(s=>s.trim()).filter(Boolean):descriptor.kind==='number'?(text.trim()===''?null:Number(text)):text
        edit(path,JSON.stringify({...currentObject,[descriptor.key]:next}),'json')
      } else edit(path+'/'+descriptor.key,text,descriptor.kind)
    }
    return <div key={path} className="rounded-lg border border-border p-3 space-y-3">
      <Label htmlFor={id}>{labels[key]||key}{overridden&&<span className="ml-2 text-xs text-amber-400">部署覆盖</span>}</Label>
      <Select id={id} value={enabled?'enabled':'disabled'} onChange={e=>edit(path,e.target.value==='disabled'?'null':JSON.stringify(Object.fromEntries(fields.map(f=>[f.key,f.initial]))),'json')}>
        <option value="disabled">未设置（使用网关默认策略）</option><option value="enabled">设置此项</option>
      </Select>
      {enabled&&fields.map(descriptor=>{
        const child=path+'/'+descriptor.key,childId='gateway-setting'+child
        const original=currentObject[descriptor.key]
        const text=drafts[child]?.text??(Array.isArray(original)?original.join('\n'):original===undefined||original===null?'':String(original))
        return <div key={child} className="space-y-1"><Label htmlFor={childId}>{labels[descriptor.key]||descriptor.key}</Label>
          {descriptor.options?<Select id={childId} value={text} onChange={e=>update(descriptor,e.target.value)}>{descriptor.options.map(option=><option key={option} value={option}>{option}</option>)}</Select>:
            descriptor.kind==='boolean'?<Select id={childId} value={text} onChange={e=>update(descriptor,e.target.value)}><option value="true">启用</option><option value="false">禁用</option></Select>:
            descriptor.kind==='lines'?<Textarea id={childId} rows={3} value={text} onChange={e=>update(descriptor,e.target.value)}/>:
            <Input id={childId} type={descriptor.kind==='number'?'number':hidden?'password':'text'} value={text} autoComplete="off" placeholder={hidden?'已配置；未编辑则保留原值':''} onChange={e=>update(descriptor,e.target.value)}/>}</div>
      })}
      {hidden&&enabled&&<p className="text-xs text-muted-foreground">证书路径已隐藏，未编辑的路径保持原值。</p>}
      <p className="text-xs text-muted-foreground">保存后需重启网关；不会立即改变当前连接。</p>
      {changed&&<Button size="sm" variant="ghost" onClick={()=>undo(path)}>撤销此项修改</Button>}
    </div>
  }
  async function save() {
    if(!view||busy)return
    setBusy(true);setError('');setNotice('')
    try {
      const changes:Record<string,ConfigValue>={}
      for(const [path,draft] of Object.entries(drafts)) {
        const {text,kind}=draft
        if(kind==='number') {
          const value=Number(text)
          if(text.trim()===''||!Number.isSafeInteger(value)) throw new Error('数值参数必须填写有效整数。')
          changes[path]=value
        } else if(kind==='boolean') changes[path]=text==='true'
        else if(kind==='lines') changes[path]=text.split('\n').map(v=>v.trim()).filter(Boolean)
        else if(kind==='json') {
          try {changes[path]=JSON.parse(text)} catch {throw new Error(`${labels[path.split('/').at(-1)!]||'结构化参数'} 的 JSON 格式无效。`)}
          const object=changes[path]
          if(object&&typeof object==='object'&&!Array.isArray(object))for(const field of objects[path]||[]) {
            if(field.kind==='number'&&(typeof object[field.key]!=='number'||!Number.isSafeInteger(object[field.key])))throw new Error(`${labels[field.key]} 必须填写有效整数。`)
          }
        } else changes[path]=text
      }
      const response=await api.saveGatewayConfiguration(view.revision,changes)
      if(!response.data)throw new Error('未返回网关保存结果。')
      setView(response.data);setDrafts({});setReplacements({});setNotice('网关配置已保存，重启网关后生效。当前串流继续使用原配置。')
    }catch(e){setError(e instanceof Error?e.message:'保存网关配置失败')}
    finally{setBusy(false)}
  }
  function field(value:ConfigValue,path:string,key:string):React.ReactNode {
    if(objects[path])return optionalObject(value,path,key,objects[path])
    const hidden=view?.redacted_paths.includes(path)
    const replaced=replacements[path]
    const object=value!==null && typeof value==='object' && !Array.isArray(value)
    const rows=Array.isArray(value)&&value.some(v=>v!==null&&typeof v==='object')
    const collection=Array.isArray(value)&&(rows||value.length===0)&&!['urls','ips'].includes(key)
    if(object&&path.split('/').length===2) return <div key={path} className="space-y-4">{Object.entries(value).map(([k,v])=>field(v,path+'/'+pointer(k),k))}</div>
    if((object||collection)&&!replaced) return <div key={path} className="space-y-3 rounded-lg border border-border p-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{labels[key]||key}</h4>{collection&&<Button size="sm" variant="outline" onClick={()=>{setReplacements(r=>({...r,[path]:true}));edit(path,'','json')}}>替换列表</Button>}</div>
      {object?Object.entries(value).map(([k,v])=>field(v,path+'/'+pointer(k),k)):Array.isArray(value)&&value.map((v,i)=>field(v,path+'/'+i,`${i+1}`))}
      {collection&&Array.isArray(value)&&value.length===0&&<p className="text-xs text-muted-foreground">未配置条目。</p>}
    </div>
    let kind:Kind=typeof value==='boolean'?'boolean':typeof value==='number'?'number':typeof value==='string'?'string':Array.isArray(value)||key==='urls'||key==='ips'?'lines':nullableStrings.has(key)||key==='credential'?'string':'json'
    if(replaced)kind='json'
    const draft=drafts[path]
    const cleared=kind==='string'&&draft?.kind==='json'&&draft.text==='null'
    const text=cleared?'':draft?.text??(hidden?'':kind==='json'?JSON.stringify(value,null,2):Array.isArray(value)?value.join('\n'):value===null?'':String(value))
    const id='gateway-setting'+path
    const overridden=view?.overridden_paths.some(p=>path===p||path.startsWith(p+'/'))
    const sensitive=hidden||key==='credential'||key==='media_ticket_secret'
    return <div key={path} className="space-y-1 min-w-0">
      <Label htmlFor={id}>{labels[key]||key}{overridden&&<span className="ml-2 text-xs text-amber-400">部署覆盖</span>}</Label>
      {kind==='boolean'?<Select id={id} value={text} onChange={e=>edit(path,e.target.value,kind)}><option value="true">启用</option><option value="false">禁用</option></Select>:
        kind==='json'||kind==='lines'?<Textarea id={id} rows={kind==='json'?4:3} value={text} autoComplete="off" spellCheck={false} placeholder={hidden?'已配置；仅填写需要替换的新值':kind==='json'?'填写完整 JSON 值；null 表示清空可选配置':''} onChange={e=>edit(path,e.target.value,kind)}/>:
        <Input id={id} type={sensitive?'password':kind==='number'?'number':'text'} autoComplete="off" value={text} placeholder={hidden?'已配置；留空且不编辑则保留':''} onChange={e=>edit(path,e.target.value,kind)}/>}
      {hidden&&<p className="text-xs text-muted-foreground">原值已隐藏；未编辑的字段会保留。</p>}
      {replaced&&<Alert variant="warning">这是完整列表替换。请填写所有需要保留的条目及其凭据；已隐藏的原凭据不会自动补入。</Alert>}
      {kind==='json'&&!replaced&&<p className="text-xs text-muted-foreground">高级结构参数，由网关校验字段和取值。证书、信任及网络地址变更需协调部署后重启。</p>}
      {kind==='json'&&examples[key]&&<p className="text-xs text-muted-foreground break-all">格式示例：<code>{examples[key]}</code></p>}
      {cleared&&<p className="text-xs text-amber-400">保存后清空此可选配置，重启生效。</p>}
      <div className="flex flex-wrap gap-2">
        {nullableStrings.has(key)&&<Button size="sm" variant="ghost" onClick={()=>edit(path,'null','json')}>清空可选配置</Button>}
        {draft&&<Button size="sm" variant="ghost" onClick={()=>{setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([p])=>p!==path)));setReplacements(current=>({...current,[path]:false}));setError('')}}>撤销此项修改</Button>}
      </div>
    </div>
  }
  return <Card>
    <CardHeader><CardTitle>媒体网关配置</CardTitle><p className="text-sm text-muted-foreground">统一管理原生网关参数。以下设置均在网关重启后生效；会话音量与控制权仍在渲染会话页面实时调整。</p></CardHeader>
    <CardContent className="space-y-4">
      {view&&<div className="space-y-1 text-xs text-muted-foreground">
        <p className="break-all">已保存版本：<code>{view.revision}</code></p>
        <p className="break-all">运行版本：<code>{view.running_revision||'网关未提供运行版本证据'}</code></p>
        {view.running_revision===view.revision&&!view.restart_required&&<p role="status" className="text-emerald-400">当前进程已加载此配置文件版本。</p>}
      </div>}
      {view?.restart_required&&<Alert variant="warning" role="status">网关存在待生效配置，请在维护时段协调重启。</Alert>}
      {!!view?.overridden_paths.length&&<Alert variant="warning">部分字段由启动参数或环境变量覆盖，修改文件后仍可能使用部署值。</Alert>}
      {error&&<Alert variant="error" role="alert">{error}</Alert>}
      {notice&&<Alert variant="success" role="status">{notice}</Alert>}
      <fieldset disabled={busy} className="space-y-3 min-w-0">{view&&Object.entries(view.values).map(([key,value])=><details key={key} className="rounded-lg border border-border bg-muted/20 p-4"><summary className="cursor-pointer font-medium">{labels[key]||key}<span className="float-right text-xs font-normal text-muted-foreground">重启生效</span></summary><div className="mt-4">{field(value,'/'+pointer(key),key)}</div></details>)}</fieldset>
      <div className="flex flex-wrap gap-3"><Button onClick={save} disabled={busy||!Object.keys(drafts).length}>保存网关配置</Button><Button variant="outline" onClick={load} disabled={busy}>{Object.keys(drafts).length?'放弃网关修改并重新读取':'重新读取网关配置'}</Button></div>
    </CardContent>
  </Card>
}
