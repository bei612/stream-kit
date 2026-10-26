import { Badge } from '@/components/ui/badge'

const statusMap: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'default' }> = {
  running: { label: '运行中', variant: 'success' },
  ready: { label: '就绪', variant: 'info' },
  stopped: { label: '已停止', variant: 'muted' },
  starting: { label: '启动中', variant: 'warning' },
  unhealthy: { label: '不健康', variant: 'warning' },
  crashed: { label: '已崩溃', variant: 'danger' },
  error: { label: '错误', variant: 'danger' },
  uploading: { label: '上传中', variant: 'default' },
  extracting: { label: '解压中', variant: 'default' },
  detecting: { label: '检测中', variant: 'warning' },
  registering: { label: '注册中', variant: 'default' },
  register_failed: { label: '注册失败', variant: 'danger' },
}

export default function StatusBadge({ status }: { status: string }) {
  const info = statusMap[status] || { label: status, variant: 'muted' as const }
  return (
    <Badge variant={info.variant}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {info.label}
    </Badge>
  )
}
