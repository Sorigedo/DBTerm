type SaveOutcome =
  | { status: 'busy' | 'cancelled' | 'stale' }
  | { status: 'failed'; error: unknown }
  | { status: 'committed'; warning?: unknown }

/** Reserve synchronously: React state cannot serialize calls before an await. */
export function createSaveLifecycle() {
  let busy = false
  return {
    get busy() { return busy },
    async run(callbacks: {
      confirm: () => Promise<boolean>
      current: () => boolean
      write: () => Promise<void>
      committed: () => void
      followUp: () => Promise<void>
    }): Promise<SaveOutcome> {
      if (busy) return { status: 'busy' }
      busy = true
      try {
        try {
          if (!(await callbacks.confirm())) return { status: 'cancelled' }
          if (!callbacks.current()) return { status: 'stale' }
          await callbacks.write()
        } catch (error) {
          return { status: 'failed', error }
        }
        // A successful database receipt must never become a failed write because
        // refreshing the UI or recording local history throws afterwards.
        if (!callbacks.current()) return { status: 'committed' }
        try {
          callbacks.committed()
          await callbacks.followUp()
          return { status: 'committed' }
        } catch (warning) {
          return { status: 'committed', warning }
        }
      } finally {
        busy = false
      }
    },
  }
}
