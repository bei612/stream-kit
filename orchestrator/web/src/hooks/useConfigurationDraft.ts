import { useState } from 'react'

// Clean forms derive directly from current server state. Only an actual edit
// owns a snapshot, so a delayed effect cannot overwrite a newer input event.
export function useConfigurationDraft<T>(current: T, equal: (a: T, b: T) => boolean) {
  const [draft, setDraft] = useState<{ baseline: T; value: T } | null>(null)
  return {
    value: draft?.value ?? current,
    baseline: draft?.baseline ?? current,
    dirty: draft !== null,
    stale: draft !== null && !equal(draft.baseline, current),
    edit(value: T) {
      setDraft(previous => {
        const baseline = previous?.baseline ?? current
        return equal(value, baseline) ? null : { baseline, value }
      })
    },
    reset() { setDraft(null) },
  }
}
