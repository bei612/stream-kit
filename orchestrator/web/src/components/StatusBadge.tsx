import { Badge } from '@/components/ui/badge'
import { InfoTooltip } from '@/components/ui/tooltip'
import { useManagementLocale } from '@/i18n'

const statusMap: Record<string, { key: string; helpKey: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'default' }> = {
  running: { key: 'status.running', helpKey: 'status.runningHelp', variant: 'success' }, ready: { key: 'status.ready', helpKey: 'status.readyHelp', variant: 'info' }, stopped: { key: 'status.stopped', helpKey: 'status.stoppedHelp', variant: 'muted' },
  starting: { key: 'status.starting', helpKey: 'status.startingHelp', variant: 'warning' }, unhealthy: { key: 'status.unhealthy', helpKey: 'status.unhealthyHelp', variant: 'warning' }, crashed: { key: 'status.crashed', helpKey: 'status.crashedHelp', variant: 'danger' },
  error: { key: 'status.error', helpKey: 'status.errorHelp', variant: 'danger' }, uploading: { key: 'status.uploading', helpKey: 'status.uploadingHelp', variant: 'default' }, extracting: { key: 'status.extracting', helpKey: 'status.extractingHelp', variant: 'default' },
  detecting: { key: 'status.detecting', helpKey: 'status.detectingHelp', variant: 'warning' }, registering: { key: 'status.registering', helpKey: 'status.registeringHelp', variant: 'default' }, register_failed: { key: 'status.register_failed', helpKey: 'status.registerFailedHelp', variant: 'danger' },
}

export default function StatusBadge({ status }: { status: string }) {
  const { t } = useManagementLocale()
  const info = statusMap[status]
  const label = info ? t(info.key as Parameters<typeof t>[0]) : status
  return (
    <Badge variant={info?.variant ?? 'muted'}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
      {info && <InfoTooltip label={`${label} ${t(info.helpKey as Parameters<typeof t>[0])}`} side="top">{t(info.helpKey as Parameters<typeof t>[0])}</InfoTooltip>}
    </Badge>
  )
}
