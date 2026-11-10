// Owns acceptance of asynchronous results, not the underlying transport. A late
// success or error must not publish into a newer request or a retired consumer.
export function createRequestScope() {
  let active = true
  let generation = 0
  return {
    activate() { active = true },
    retire() { active = false; generation++ },
    begin(): (() => boolean) | null {
      if (!active) return null
      const request = ++generation
      return () => active && request === generation
    },
  }
}
