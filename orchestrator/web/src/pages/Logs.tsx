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
import { useManagementLocale } from '@/i18n'

export default function Logs() {
  const { t } = useManagementLocale()
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
    <Page title={t('logs.title')} eyebrow={t('logs.eyebrow')} description={t('logs.description')} actions={
          <Select
            aria-label={t('logs.type')}
            value={filter}
            onChange={e => { setFilter(e.target.value); setPage(1) }}
            className="sm:w-auto"
          >
            <option value="">{t('logs.allTypes')}</option>
            <option value="component">{t('logs.component')}</option>
            <option value="app">{t('logs.application')}</option>
            <option value="system">{t('logs.system')}</option>
          </Select>
    }>
    <QueryWrapper loading={loading} error={error} onRetry={refresh}>
        {logs.length === 0 && !loading ? (
          <EmptyState title={t('logs.empty')} description={t('logs.emptyDescription')} />
        ) : (
          <Table label={t('logs.title')} className="min-w-[44rem] table-fixed">
            <TableHead>
              <TableRow>
                <Th className="w-44">{t('logs.time')}</Th>
                <Th className="w-28">{t('logs.operation')}</Th>
                <Th className="w-32">{t('logs.target')}</Th>
                <Th className="w-20">{t('logs.result')}</Th>
                <Th>{t('logs.descriptionColumn')}</Th>
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
                      {log.result === 'success' ? t('logs.success') : t('logs.failure')}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground text-xs whitespace-normal">{log.message}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {(hasPrev || hasMore) && (
          <nav aria-label={t('logs.pagination')} className="action-row justify-center">
            <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={!hasPrev}>{t('logs.previous')}</Button>
            <span className="px-3 py-1 text-sm text-muted-foreground">{t('logs.page')} {page}</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!hasMore}>{t('logs.next')}</Button>
          </nav>
        )}
    </QueryWrapper>
    </Page>
  )
}
