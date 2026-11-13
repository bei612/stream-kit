import { useCallback, useEffect, useRef } from 'react'
import { hashKey, useQuery as useManagedQuery, type QueryKey } from '@tanstack/react-query'
import type { Pagination } from '@/api/response'

interface UseQueryOptions<T> {
  queryKey: QueryKey
  queryFn: (signal: AbortSignal) => Promise<{ data?: T; pagination?: Pagination }>
  pollInterval?: number | false
  wsInvalidateEvents?: string[]
  enabled?: boolean
}

interface UseQueryResult<T> {
  data: T | null
  pagination?: Pagination
  loading: boolean
  error: string
  refreshing: boolean
  refresh: () => Promise<boolean>
}

// Preserve the page contract while the established query library owns cache
// identity, subscriptions, concurrent results, polling and cancellation.
export function useQuery<T>(opts: UseQueryOptions<T>): UseQueryResult<T> {
  const { queryKey, queryFn, pollInterval = 10000, wsInvalidateEvents, enabled = true } = opts
  const query = useManagedQuery({
    queryKey, queryFn: ({ signal }) => queryFn(signal), enabled,
    refetchInterval: enabled ? pollInterval : false,
  })
  const identity = hashKey(queryKey)
  const activeIdentity = useRef<string | null>(null)
  useEffect(() => {
    activeIdentity.current = enabled ? identity : null
    return () => { activeIdentity.current = null }
  }, [identity, enabled])

  const { refetch } = query
  const refresh = useCallback(async () => {
    // Delayed commands can retain callbacks after navigation or disablement.
    // They cannot refetch another resource or manufacture confirmation.
    if (!enabled || activeIdentity.current !== identity) return false
    try {
      const result = await refetch({ throwOnError: true })
      return activeIdentity.current === identity && result.isSuccess && !result.isFetching
    } catch { return false }
  }, [enabled, identity, refetch])

  useEffect(() => {
    if (!wsInvalidateEvents?.length) return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.type && wsInvalidateEvents.includes(detail.type)) void refresh()
    }
    const reconnect = () => { void refresh() }
    window.addEventListener('ws-event', handler)
    window.addEventListener('ws-connected', reconnect)
    return () => {
      window.removeEventListener('ws-event', handler)
      window.removeEventListener('ws-connected', reconnect)
    }
  }, [wsInvalidateEvents, refresh])

  return {
    data: query.data?.data ?? null, pagination: query.data?.pagination,
    loading: enabled && query.isPending,
    error: query.error ? (query.error instanceof Error ? query.error.message : '请求失败') : '',
    refreshing: query.isFetching && !query.isPending,
    refresh,
  }
}
