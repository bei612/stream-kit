import StatusBadge from '@/components/StatusBadge'
import { useManagementLocale } from '@/i18n'

export default function AppLifecycleStatus({app}: {app: {status:string; lifecycle?:{session_state:string}}}) {
  const { t } = useManagementLocale()
  const state = app.lifecycle?.session_state
  const label = state === 'stopping' ? t('lifecycle.stopping') : state === 'starting' ? t('lifecycle.starting') : state === 'running' ? t('lifecycle.running') : state === 'degraded' ? t('lifecycle.degraded') : ''
  return <div className="flex flex-wrap items-center gap-2"><StatusBadge status={app.status} />{label && <span className="text-xs text-muted-foreground">{label}</span>}</div>
}
