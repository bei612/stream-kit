import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import type { ConfigurationView, ConfigValue } from '@/api/configuration'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select, Textarea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

const labels:Record<string,string> = {
  server:'管理服务与登录',components:'服务组件',sunshine_api:'串流编码器连接',moonlight_web:'媒体网关连接',storage:'应用与存储',process:'进程管理',notifications:'通知',log:'日志',templates:'启动参数模板',
  bind_address:'监听地址',username:'用户名',password:'密码',jwt_secret:'管理签名密钥',media_ticket_secret:'媒体签名密钥',cors_origins:'允许访问的来源',tls_cert:'TLS 证书路径',tls_key:'TLS 私钥路径',
  exe_path:'可执行程序路径',args:'启动参数',working_dir:'工作目录',env:'环境变量',auto_start:'自动启动',restart_on_crash:'崩溃后重启',restart_delay_seconds:'重启等待（秒）',max_restart_attempts:'最大重启次数',health_check:'健康检查',
  type:'检查类型',url:'检查地址',interval_seconds:'检查间隔（秒）',timeout_seconds:'检查超时（秒）',unhealthy_threshold:'异常判定次数',healthy_threshold:'恢复判定次数',startup_timeout_seconds:'启动等待（秒）',verify_ssl:'校验 TLS 证书',
  base_url:'服务连接地址',public_url:'浏览器访问地址',server_info_url:'编码器信息地址',apps_dir:'应用存储目录',temp_dir:'临时目录',db_path:'数据库路径',max_upload_size_bytes:'上传大小上限（字节）',max_extract_size_bytes:'解压大小上限（字节）',max_file_count:'解压文件数上限',
  monitor_interval_seconds:'进程检查间隔（秒）',graceful_shutdown_timeout_seconds:'停止等待（秒）',webhook_url:'Webhook 地址',events:'通知事件',level:'日志级别',file:'日志文件',enabled:'启用',path:'文件路径',max_size_mb:'单文件上限（MB）',max_backups:'保留文件数',max_age_days:'保留天数',compress:'压缩历史日志',access_log:'访问日志',exclude_paths:'排除路径',operation_log:'操作日志',max_count:'保留记录数',
}
const lists = new Set(['cors_origins','events','exclude_paths'])
const pointer = (key:string) => key.replaceAll('~','~0').replaceAll('/','~1')

export function ConfigurationEditor() {
  const [view,setView]=useState<ConfigurationView|null>(null)
  const [drafts,setDrafts]=useState<Record<string,string>>({})
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [mapKeys,setMapKeys]=useState<Record<string,string>>({})
  const [added,setAdded]=useState<Record<string,string[]>>({})
  async function load() {
    setBusy(true); setError(''); setNotice('')
    try { const response=await api.getConfiguration(); if(!response.data) throw new Error('未返回配置'); setView(response.data); setDrafts({}); setAdded({}); setMapKeys({}) }
    catch(e:unknown) { setError(e instanceof Error?e.message:'无法读取配置') }
    finally { setBusy(false) }
  }
  useEffect(()=>{void load()},[])
  const changed=Object.keys(drafts).length
  const edit=(path:string,value:string)=>{setDrafts(d=>({...d,[path]:value}));setNotice('')}
  const original=(path:string):ConfigValue=>{
    let value:ConfigValue=view?.values||{}
    for(const segment of path.slice(1).split('/')) {
      const key=segment.replaceAll('~1','/').replaceAll('~0','~')
      value=value && typeof value==='object' && !Array.isArray(value)?value[key]??null:null
    }
    return value
  }
  async function save() {
    if(!view || busy) return
    setError('');setNotice('');setBusy(true)
    try {
      const changes:Record<string,ConfigValue>={}
      for(const [path,text] of Object.entries(drafts)) {
        const old=original(path), key=path.split('/').at(-1)!
        if(typeof old==='boolean' || key==='verify_ssl') changes[path]=text==='default'?null:text==='true'
        else if(typeof old==='number') {
          const number=Number(text)
          if(text.trim()==='' || !Number.isSafeInteger(number)) throw new Error(`${labels[key]||key} 必须是有效整数`)
          changes[path]=number
        } else if(Array.isArray(old)||lists.has(key)) changes[path]=text.split('\n').map(s=>s.trim()).filter(Boolean)
        else changes[path]=text
      }
      const response=await api.saveConfiguration(view.revision,changes)
      if(!response.data) throw new Error('未返回保存结果')
      setView(response.data);setDrafts({});setAdded({});setNotice('配置已保存。服务重启后生效，当前串流继续使用原配置。')
    } catch(e:unknown) { setError(e instanceof Error?e.message:'保存失败') }
    finally { setBusy(false) }
  }
  function fields(value:ConfigValue,path:string,key:string):React.ReactNode {
    const dictionary=key==='env'||key==='templates'
    if(value && typeof value==='object' && !Array.isArray(value) || dictionary) {
      const entries=value && typeof value==='object' && !Array.isArray(value)?value:{}
      const extra=(added[path]||[]).filter(k=>!(k in entries))
      return <div key={path} className={path.split('/').length>2?'space-y-4 rounded-lg border border-border p-3':'space-y-4'}>
        {path.split('/').length>2&&<h3 className="font-medium text-sm">{labels[key]||key}</h3>}
        {Object.entries(entries).map(([k,v])=>fields(v,path+'/'+pointer(k),k))}
        {extra.map(k=>fields('',path+'/'+pointer(k),k))}
        {dictionary && <div className="flex flex-wrap gap-2">
          <Input className="flex-1 min-w-0" aria-label={`${labels[key]}新名称`} placeholder="新增名称" value={mapKeys[path]||''} onChange={e=>setMapKeys(k=>({...k,[path]:e.target.value}))}/>
          <Button type="button" variant="outline" onClick={()=>{const name=(mapKeys[path]||'').trim();if(!name||name in entries||extra.includes(name))return;setAdded(a=>({...a,[path]:[...(a[path]||[]),name]}));setMapKeys(k=>({...k,[path]:''}))}}>添加条目</Button>
        </div>}
      </div>
    }
    const hidden=view?.redacted_paths.includes(path), id='setting'+path
    const sensitive=hidden||['password','jwt_secret','media_ticket_secret','webhook_url','args'].includes(key)||path.includes('/env/')||path.startsWith('/templates/')
    const text=drafts[path]??(hidden?'':Array.isArray(value)?value.join('\n'):value===null?'':String(value))
    const title=labels[key]||key
    return <div key={path} className="space-y-1">
      <Label htmlFor={id}>{title}</Label>
      {typeof value==='boolean'||key==='verify_ssl'?<Select id={id} value={drafts[path]??(value===null?'default':String(value))} onChange={e=>edit(path,e.target.value)}>
        {key==='verify_ssl'&&<option value="default">使用默认策略</option>}<option value="true">启用</option><option value="false">禁用</option>
      </Select>:Array.isArray(value)||lists.has(key)?<Textarea id={id} rows={3} value={text} placeholder="每行一项" onChange={e=>edit(path,e.target.value)}/>:<Input id={id} type={sensitive?'password':typeof value==='number'?'number':'text'} autoComplete="off" value={text} placeholder={hidden?'已设置；不编辑则保留原值':''} onChange={e=>edit(path,e.target.value)}/>}
      {hidden&&<p className="text-xs text-muted-foreground">内容已隐藏。输入新值会替换原值。<button type="button" className="ml-2 underline" onClick={()=>edit(path,'')}>清空此项</button></p>}
    </div>
  }
  return <Card>
    <CardHeader><CardTitle>服务配置</CardTitle><p className="text-sm text-muted-foreground">按分组修改配置。会话控制权与音量在渲染会话页面实时调整；以下设置需重启服务。</p></CardHeader>
    <CardContent className="space-y-4">
      {view?.restart_required&&<Alert variant="warning" role="status">存在待生效配置。请在维护时段通过服务管理器重启服务。</Alert>}
      {!!view?.environment_overrides.length&&<Alert variant="warning">检测到环境变量覆盖：{view.environment_overrides.join('、')}。对应设置可能继续由部署环境决定。</Alert>}
      {error&&<Alert variant="error" role="alert">{error}</Alert>}
      {notice&&<Alert variant="success" role="status">{notice}</Alert>}
      <fieldset disabled={busy} className="space-y-3 min-w-0">
        {view&&Object.entries(view.values).map(([key,value])=><details key={key} className="rounded-lg border border-border bg-muted/20 p-4">
          <summary className="cursor-pointer font-medium">{labels[key]||key}<span className="float-right text-xs font-normal text-muted-foreground">重启生效</span></summary>
          <div className="mt-4 space-y-4">{fields(value,'/'+pointer(key),key)}</div>
        </details>)}
      </fieldset>
      <div className="flex flex-wrap gap-3 items-center">
        <Button onClick={save} disabled={busy||!changed}>{busy?'处理中…':`保存配置${changed?`（${changed} 项）`:''}`}</Button>
        <Button variant="outline" onClick={load} disabled={busy}>{changed?'放弃修改并重新读取':'重新读取'}</Button>
      </div>
    </CardContent>
  </Card>
}
