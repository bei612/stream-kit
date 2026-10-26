import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  error: 'border-red-400/20 bg-red-900/20 text-red-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
}

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants
}

export function Alert({ className, variant = 'info', ...props }: AlertProps) {
  return (
    <div
      className={cn('rounded-lg border p-3 text-sm', variants[variant], className)}
      {...props}
    />
  )
}
