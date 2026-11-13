import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/layout/Page'

interface Props {
  loading: boolean
  error: string
  refreshing?: boolean
  onRetry?: () => void
  children: ReactNode
}

export default function QueryWrapper({ loading, error, refreshing, onRetry, children }: Props) {
  if (loading) {
    return (
      <div className="query-state" role="status" aria-live="polite">
        <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="hsl(var(--primary))" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert">
        <EmptyState title="暂时无法读取" description={error} action={onRetry && <Button variant="outline" onClick={onRetry}>重试</Button>} />
      </div>
    )
  }

  return (
    <>
      {refreshing && (
        <div className="text-xs text-primary text-right mb-1 animate-pulse">刷新中...</div>
      )}
      {children}
    </>
  )
}
