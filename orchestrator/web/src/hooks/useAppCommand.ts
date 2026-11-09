import { useRef, useState } from 'react'

export type AppCommand = 'save' | 'launch' | 'stop' | 'delete' | 'select' | 'register'

// One in-flight command per resource, including the confirming refresh.
// The ref closes the same-frame double-click gap before React renders disabled
// buttons. Invoking the task synchronously preserves browser launch gestures.
export function useResourceCommand<Command extends string>(refresh: () => Promise<void>) {
  const active = useRef(new Map<string, Command>())
  const [pending, setPending] = useState<Record<string, Command>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  return {
    pending, error, errors,
    async run(id: string, command: Command, task: () => Promise<unknown>) {
      if (active.current.has(id)) return false
      active.current.set(id, command)
      setPending(Object.fromEntries(active.current))
      setError('')
      setErrors(previous => ({ ...previous, [id]: '' }))
      let failure = ''
      const report = (message: string) => {
        failure = message
        setError(message)
        setErrors(previous => ({ ...previous, [id]: message }))
      }
      try {
        await task()
      } catch (cause) {
        report(cause instanceof Error ? cause.message : '操作失败，请重试。')
      } finally {
        try { await refresh() }
        catch (cause) { report([failure, '操作后状态未确认：' + (cause instanceof Error ? cause.message : '刷新失败，请重试。')].filter(Boolean).join('；')) }
        finally {
          active.current.delete(id)
          setPending(Object.fromEntries(active.current))
        }
      }
      return !failure
    },
  }
}

export function useAppCommand(refresh: () => Promise<void>) {
  return useResourceCommand<AppCommand>(refresh)
}
