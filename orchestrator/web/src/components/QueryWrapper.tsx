import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/layout/Page'
import { useManagementLocale } from '@/i18n'

interface Props {
  loading: boolean
  error: string
  refreshing?: boolean
  onRetry?: () => void
  children: ReactNode
}

export default function QueryWrapper({ loading, error, refreshing, onRetry, children }: Props) {
  const { t } = useManagementLocale()
  if (loading) {
    return (
      <div className="query-state" role="status" aria-live="polite">
        <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="hsl(var(--primary))" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        {t('common.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert">
        <EmptyState title={t('common.unavailable')} description={error} action={onRetry && <Button variant="outline" onClick={onRetry}>{t('common.retry')}</Button>} />
      </div>
    )
  }

  return (
    <>
      {refreshing && (
        <div className="text-xs text-primary text-right mb-1 animate-pulse">{t('common.refreshing')}</div>
      )}
      {children}
    </>
  )
}
