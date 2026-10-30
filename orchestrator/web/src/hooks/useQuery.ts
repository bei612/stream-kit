import { useState, useEffect, useRef, useCallback } from 'react'

interface UseQueryOptions<T> {
  queryFn: () => Promise<{ data?: T }>
  pollInterval?: number         // ms, default 10000
  wsInvalidateEvents?: string[] // WebSocket event types that trigger refresh
  enabled?: boolean             // default true
}

interface UseQueryResult<T> {
  data: T | null
  loading: boolean    // true only on first fetch
  error: string       // empty = no error
  refreshing: boolean // true on subsequent fetches
  refresh: () => void
}

export function useQuery<T>(opts: UseQueryOptions<T>): UseQueryResult<T> {
  const { queryFn, pollInterval = 10000, wsInvalidateEvents, enabled = true } = opts
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const firstLoad = useRef(true)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (!enabled) return
    if (!firstLoad.current) setRefreshing(true)
    try {
      const res = await queryFn()
      if (mounted.current) {
        setData((res.data ?? null) as T | null)
        setError('')
      }
    } catch (e: any) {
      if (mounted.current) setError(e.message || '请求失败')
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
        firstLoad.current = false
      }
    }
  }, [queryFn, enabled])

  // Initial fetch + polling
  useEffect(() => {
    mounted.current = true
    firstLoad.current = true
    setLoading(true)
    refresh()
    const timer = setInterval(refresh, pollInterval)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [refresh, pollInterval])

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

  return { data, loading, error, refreshing, refresh }
}
