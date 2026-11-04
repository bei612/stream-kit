import { useRef, useState } from 'react'

export type AppCommand = 'save' | 'launch' | 'stop' | 'delete' | 'select' | 'register'

// One in-flight command per application, including the confirming refresh.
// The ref closes the same-frame double-click gap before React renders disabled
// buttons. Invoking the task synchronously preserves browser launch gestures.
export function useAppCommand(refresh: () => Promise<void>) {
  const active = useRef(new Map<string, AppCommand>())
  const [pending, setPending] = useState<Record<string, AppCommand>>({})
  const [error, setError] = useState('')
  return {
    pending, error,
    async run(id: string, command: AppCommand, task: () => Promise<void>) {
      if (active.current.has(id)) return false
      active.current.set(id, command)
      setPending(Object.fromEntries(active.current))
      setError('')
      try {
        await task()
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
        return false
      } finally {
        try { await refresh() } finally {
          active.current.delete(id)
          setPending(Object.fromEntries(active.current))
        }
      }
    },
  }
}
