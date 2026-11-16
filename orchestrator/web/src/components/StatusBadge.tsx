import { Badge } from '@/components/ui/badge'
import { useManagementLocale } from '@/i18n'

const statusMap: Record<string, { key: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'default' }> = {
  running: { key: 'status.running', variant: 'success' }, ready: { key: 'status.ready', variant: 'info' }, stopped: { key: 'status.stopped', variant: 'muted' },
  starting: { key: 'status.starting', variant: 'warning' }, unhealthy: { key: 'status.unhealthy', variant: 'warning' }, crashed: { key: 'status.crashed', variant: 'danger' },
  error: { key: 'status.error', variant: 'danger' }, uploading: { key: 'status.uploading', variant: 'default' }, extracting: { key: 'status.extracting', variant: 'default' },
  detecting: { key: 'status.detecting', variant: 'warning' }, registering: { key: 'status.registering', variant: 'default' }, register_failed: { key: 'status.register_failed', variant: 'danger' },
}

export default function StatusBadge({ status }: { status: string }) {
  const { t } = useManagementLocale()
  const info = statusMap[status]
  return (
    <Badge variant={info?.variant ?? 'muted'}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {info ? t(info.key as Parameters<typeof t>[0]) : status}
    </Badge>
  )
}
