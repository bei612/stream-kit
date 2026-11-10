import { useState, useEffect, useRef, useCallback } from 'react'
import type { Pagination } from '@/api/response'

interface UseQueryOptions<T> {
  queryFn: () => Promise<{ data?: T; pagination?: Pagination }>
  pollInterval?: number         // ms, default 10000
  wsInvalidateEvents?: string[] // WebSocket event types that trigger refresh
  enabled?: boolean             // default true
}

interface UseQueryResult<T> {
  data: T | null
  pagination?: Pagination
  loading: boolean    // true only on first fetch
  error: string       // empty = no error
  refreshing: boolean // true on subsequent fetches
  refresh: () => Promise<boolean>
}

export function useQuery<T>(opts: UseQueryOptions<T>): UseQueryResult<T> {
  const { queryFn, pollInterval = 10000, wsInvalidateEvents, enabled = true } = opts
  const [result, setResult] = useState<{ data: T | null; pagination?: Pagination }>({ data: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const firstLoad = useRef(true)
  const mounted = useRef(true)
  const revision = useRef(0)
  const invalidateRequests = useCallback(() => { revision.current++ }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return false
    let accepted = false
    const requestRevision = ++revision.current
    if (!firstLoad.current) setRefreshing(true)
    try {
      const res = await queryFn()
      if (mounted.current && requestRevision === revision.current) {
        setResult({ data: res.data ?? null, pagination: res.pagination })
        setError('')
        accepted = true
      }
    } catch (e: unknown) {
      if (mounted.current && requestRevision === revision.current) setError(e instanceof Error ? e.message : '请求失败')
    } finally {
      if (mounted.current && requestRevision === revision.current) {
        setLoading(false)
        setRefreshing(false)
        firstLoad.current = false
      }
    }
    return accepted
  }, [queryFn, enabled])

  // Initial fetch + polling
  useEffect(() => {
    mounted.current = true
    firstLoad.current = true
    setResult({ data: null })
    setError('')
    setLoading(true)
    refresh()
    const timer = setInterval(refresh, pollInterval)
    return () => {
      mounted.current = false
      invalidateRequests()
      clearInterval(timer)
    }
  }, [refresh, pollInterval, invalidateRequests])

  // WebSocket event-driven refresh
  useEffect(() => {
    if (!wsInvalidateEvents || wsInvalidateEvents.length === 0) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.type && wsInvalidateEvents.includes(detail.type)) {
        refresh()
      }
    }
    window.addEventListener('ws-event', handler)
    // Recover updates missed during a disconnected event stream using the
    // same authoritative query as normal refresh, without another poll loop.
    window.addEventListener('ws-connected', refresh)
    return () => {
      window.removeEventListener('ws-event', handler)
      window.removeEventListener('ws-connected', refresh)
    }
  }, [wsInvalidateEvents, refresh])

  return { ...result, loading, error, refreshing, refresh }
}
