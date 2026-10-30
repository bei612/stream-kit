import { useCallback } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import StatusBadge from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Table, TableHead, TableBody, TableRow, Th, Td } from '@/components/ui/table'
import { formatBytes, formatTime } from '@/lib/utils'
import { openViewingStream } from '@/lib/stream-access'
import { Play, Trash2, Square, Upload } from 'lucide-react'

export default function Apps() {
  const { data, loading, error, refresh } = useQuery({
    queryFn: useCallback(() => api.listApps(), []),
    pollInterval: 10000,
    wsInvalidateEvents: ['app_status'],
  })

  const apps = (data ?? []) as any[]

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除应用 "${name}" 吗？此操作不可恢复。`)) return
    try {
      await api.deleteApp(id)
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleLaunch = async (id: string) => {
    try {
      await openViewingStream(async () => {
        const res = await api.launchApp(id)
        return res.data?.stream_url
      })
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleStop = async (id: string) => {
    try {
      await api.stopApp(id)
      refresh()
    } catch (e: any) {
      alert(e.message)
    }
  }

  return (
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <div className="space-y-4">
        <div className="page-heading">
          <div><p className="page-eyebrow">渲染内容</p><h2>应用管理</h2><p className="page-description">管理上传包和本机程序，启动或结束串流。</p></div>
          <Link to="/upload">
            <Button>
              <Upload className="w-4 h-4" /> 添加应用
            </Button>
          </Link>
        </div>

        {apps.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-lg mb-2">暂无应用</p>
            <p className="text-sm">点击“添加应用”，上传压缩包或指定本机程序路径</p>
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <Th>名称</Th>
                <Th>状态</Th>
                <Th>大小</Th>
                <Th>上传时间</Th>
                <Th className="text-right">操作</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {apps.map((app: any) => (
                <TableRow key={app.id}>
                  <Td>
                    <Link to={`/apps/${app.id}`} className="text-primary hover:underline font-medium">{app.name}</Link>
                  </Td>
                  <Td><StatusBadge status={app.status} /></Td>
                  <Td className="text-muted-foreground">{formatBytes(app.extracted_size_bytes || app.file_size_bytes)}</Td>
                  <Td className="text-muted-foreground">{formatTime(app.created_at)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      {['ready', 'stopped', 'crashed'].includes(app.status) && (
                        <Button size="sm" onClick={() => handleLaunch(app.id)}>
                          <Play className="w-3 h-3" /> 启动串流
                        </Button>
                      )}
                      {app.status === 'running' && (
                        <Button size="sm" variant="destructive" onClick={() => handleStop(app.id)}>
                          <Square className="w-3 h-3" /> 停止串流
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => handleDelete(app.id, app.name)}>
                        <Trash2 className="w-3 h-3" /> 删除
                      </Button>
                    </div>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </QueryWrapper>
  )
}
