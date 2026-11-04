import StatusBadge from '@/components/StatusBadge'

export default function AppLifecycleStatus({app}: {app: {status:string; lifecycle?:{session_state:string}}}) {
  const state = app.lifecycle?.session_state
  const label = state === 'stopping' ? '观看会话停止待完成' : state === 'starting' ? '观看会话准备中' : state === 'running' ? '观看会话运行中' : state === 'degraded' ? '观看会话待恢复' : ''
  return <div className="flex flex-wrap items-center gap-2"><StatusBadge status={app.status} />{label && <span className="text-xs text-muted-foreground">{label}</span>}</div>
}
