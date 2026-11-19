import { HelpCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, safePolygon, shift, useClick, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react'

interface InfoTooltipProps {
  label: string
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/** Shared concept help: viewport-aware positioning and listeners only while open. */
export function InfoTooltip({ label, children, side = 'top' }: InfoTooltipProps) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open, onOpenChange: setOpen, placement: side, strategy: 'fixed',
    middleware: [offset(8), shift({ padding: 16 }), flip({ padding: 16, crossAxis: 'alignment', fallbackAxisSideDirection: 'start' })],
    whileElementsMounted: autoUpdate,
  })
  const { setReference, setFloating } = refs
  const hover = useHover(context, { move: false, handleClose: safePolygon() })
  const focus = useFocus(context)
  const click = useClick(context, { ignoreMouse: true })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss, role])
  return <span className="info-tooltip">
    <button ref={setReference} type="button" className="info-tooltip-trigger" aria-label={label} {...getReferenceProps()}>
      <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    {open && <FloatingPortal><span ref={setFloating} className="info-tooltip-popover" style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }} {...getFloatingProps()}>{children}</span></FloatingPortal>}
  </span>
}
