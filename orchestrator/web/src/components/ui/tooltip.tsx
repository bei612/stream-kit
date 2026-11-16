import { HelpCircle } from 'lucide-react'
import type { ReactNode } from 'react'

interface InfoTooltipProps {
  label: string
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/** Accessible, lightweight concept help. It works with pointer hover and keyboard focus. */
export function InfoTooltip({ label, children, side = 'top' }: InfoTooltipProps) {
  return <span className={`info-tooltip info-tooltip--${side}`}>
    <button type="button" className="info-tooltip-trigger" aria-label={label}>
      <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    <span className="info-tooltip-popover" role="tooltip">{children}</span>
  </span>
}
