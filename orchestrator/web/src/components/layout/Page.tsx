import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { InfoTooltip } from '@/components/ui/tooltip'
import { useManagementLocale } from '@/i18n'

interface PageProps {
  title: ReactNode
  description: string
  eyebrow?: string
  actions?: ReactNode
  badge?: ReactNode
  back?: ReactNode
  children: ReactNode
}

/** Every management route shares the same width, heading and action boundary. */
export function Page({ title, description, eyebrow, actions, badge, back, children }: PageProps) {
  const location = useLocation()
  const { t } = useManagementLocale()
  const helpAnchor = location.pathname === '/' ? 'dashboard' : location.pathname.startsWith('/stream-sessions') ? 'sessions' : location.pathname.startsWith('/settings') ? 'settings' : location.pathname.startsWith('/components') ? 'components' : location.pathname.startsWith('/upload') || location.pathname.startsWith('/apps') ? 'apps' : location.pathname.startsWith('/logs') ? 'operations' : 'overview'
  return <div className="page-stack">
    {back && <div className="page-back">{back}</div>}
    <header className="page-heading">
      <div className="page-heading-copy">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <div className="page-title-row"><h1>{title}</h1>{badge}</div>
        <p className="page-description">{description}</p>
      </div>
      <div className="page-actions"><Link to={`/docs#${helpAnchor}`} className="page-help-link"><BookOpen className="h-4 w-4" /> {t('common.readGuide')}</Link>{actions}</div>
    </header>
    {children}
  </div>
}

export function ContentGrid({ variant = 'cards', children, className }: {
  variant?: 'cards' | 'metrics' | 'detail' | 'fields' | 'settings'
  children: ReactNode
  className?: string
}) {
  return <div className={cn('content-grid', `content-grid--${variant}`, className)}>{children}</div>
}

export function EmptyState({ title, description, action }: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return <div className="empty-state">
    <h2>{title}</h2>
    {description && <p>{description}</p>}
    {action && <div className="page-actions">{action}</div>}
  </div>
}

export function Metric({ label, value, className, description }: { label: string; value: ReactNode; className?: string; description?: ReactNode }) {
  return <Card className="metric-card"><span className="metric-label">{label}{description && <InfoTooltip label={`${label} ${typeof description === 'string' ? description : '说明'}`} side="right">{description}</InfoTooltip>}</span><strong className={className}>{value}</strong></Card>
}
