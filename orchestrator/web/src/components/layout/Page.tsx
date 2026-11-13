import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

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
  return <div className="page-stack">
    {back && <div className="page-back">{back}</div>}
    <header className="page-heading">
      <div className="page-heading-copy">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <div className="page-title-row"><h1>{title}</h1>{badge}</div>
        <p className="page-description">{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
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

export function Metric({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return <Card className="metric-card"><span>{label}</span><strong className={className}>{value}</strong></Card>
}
