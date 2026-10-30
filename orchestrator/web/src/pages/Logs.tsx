import { useState, useCallback } from 'react'
import { api } from '@/api/client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import { Select } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHead, TableBody, TableRow, Th, Td } from '@/components/ui/table'
import { formatTime } from '@/lib/utils'

export default function Logs() {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')

  const queryFn = useCallback(
    () => api.getLogs({ page, size: 20, target_type: filter || undefined }),
    [page, filter]
  )
  const { data, loading, error, refresh } = useQuery({ queryFn, pollInterval: 30000 })

  // getLogs returns data as array, pagination comes alongside
  const logs = (data ?? []) as any[]

  // We need total from the raw response — useQuery passes through ApiResponse
  // For now, pagination is estimated from logs length (no empty page = has more)
  const hasMore = logs.length === 20
  const hasPrev = page > 1

  return (
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="page-heading"><div><p className="page-eyebrow">操作记录</p><h2>操作日志</h2><p className="page-description">检索服务与应用操作，定位运行问题。</p></div></div>
          <Select
            value={filter}
            onChange={e => { setFilter(e.target.value); setPage(1) }}
            className="w-auto"
          >
            <option value="">全部类型</option>
            <option value="component">组件</option>
            <option value="app">应用</option>
            <option value="system">系统</option>
          </Select>
        </div>

        {logs.length === 0 && !loading ? (
          <div className="text-center py-12 text-muted-foreground">暂无日志</div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <Th>时间</Th>
                <Th>操作</Th>
                <Th>目标</Th>
                <Th>结果</Th>
                <Th>描述</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs.map((log: any) => (
                <TableRow key={log.id}>
                  <Td className="text-muted-foreground whitespace-nowrap">{formatTime(log.created_at)}</Td>
                  <Td className="font-mono text-xs">{log.operation}</Td>
                  <Td className="text-xs">{log.target_type}/{log.target_id?.slice(0, 8) || '-'}</Td>
                  <Td>
                    <Badge variant={log.result === 'success' ? 'success' : 'danger'}>
                      {log.result === 'success' ? '成功' : '失败'}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground text-xs max-w-xs truncate">{log.message}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {(hasPrev || hasMore) && (
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={!hasPrev}>上一页</Button>
            <span className="px-3 py-1 text-sm text-muted-foreground">第 {page} 页</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!hasMore}>下一页</Button>
          </div>
        )}
      </div>
    </QueryWrapper>
  )
}
