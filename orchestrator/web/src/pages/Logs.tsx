import { useState, useCallback } from 'react'
import { api } from '@/api/client'
import { managementKeys } from '@/api/query-client'
import { useQuery } from '@/hooks/useQuery'
import QueryWrapper from '@/components/QueryWrapper'
import { EmptyState, Page } from '@/components/layout/Page'
import { Select } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHead, TableBody, TableRow, Th, Td } from '@/components/ui/table'
import { formatTime } from '@/lib/utils'

export default function Logs() {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')

  const queryFn = useCallback(
    (signal: AbortSignal) => api.getLogs({ page, size: 20, target_type: filter || undefined }, signal),
    [page, filter]
  )
  const { data, pagination, loading, error, refresh } = useQuery({ queryKey: managementKeys.logs(page, filter), queryFn, pollInterval: 30000 })

  const logs = data ?? []
  const hasMore = pagination !== undefined && pagination.page * pagination.size < pagination.total
  const hasPrev = (pagination?.page ?? page) > 1

  return (
    <Page title="操作日志" eyebrow="操作记录" description="检索服务与应用操作，定位运行问题。" actions={
          <Select
            aria-label="日志类型"
            value={filter}
            onChange={e => { setFilter(e.target.value); setPage(1) }}
            className="sm:w-auto"
          >
            <option value="">全部类型</option>
            <option value="component">组件</option>
            <option value="app">应用</option>
            <option value="system">系统</option>
          </Select>
    }>
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
        {logs.length === 0 && !loading ? (
          <EmptyState title="暂无日志" description="当前筛选下没有操作记录，可切换日志类型查看。" />
        ) : (
          <Table label="操作日志" className="min-w-[44rem] table-fixed">
            <TableHead>
              <TableRow>
                <Th className="w-44">时间</Th>
                <Th className="w-28">操作</Th>
                <Th className="w-32">目标</Th>
                <Th className="w-20">结果</Th>
                <Th>描述</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs.map(log => (
                <TableRow key={log.id}>
                  <Td className="text-muted-foreground whitespace-nowrap">{formatTime(log.created_at)}</Td>
                  <Td className="font-mono text-xs">{log.operation}</Td>
                  <Td className="text-xs">{log.target_type}/{log.target_id?.slice(0, 8) || '-'}</Td>
                  <Td>
                    <Badge variant={log.result === 'success' ? 'success' : 'danger'}>
                      {log.result === 'success' ? '成功' : '失败'}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground text-xs whitespace-normal">{log.message}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {(hasPrev || hasMore) && (
          <nav aria-label="日志分页" className="action-row justify-center">
            <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={!hasPrev}>上一页</Button>
            <span className="px-3 py-1 text-sm text-muted-foreground">第 {page} 页</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!hasMore}>下一页</Button>
          </nav>
        )}
    </QueryWrapper>
    </Page>
  )
}
