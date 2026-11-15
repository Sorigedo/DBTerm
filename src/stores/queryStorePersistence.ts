import { createJSONStorage, type StateStorage, type StorageValue } from 'zustand/middleware'

interface Storage<Value> {
  getItem: (name: string) => Value | null | Promise<Value | null>
  setItem: (name: string, value: Value) => unknown
  removeItem: (name: string) => unknown
}

export interface DebouncedStorage<Value = string> extends Storage<Value> {
  flush: () => void
}

/** Coalesce frequent writes while keeping the latest value in memory. */
export function createDebouncedStorage(
  storage: StateStorage,
  delayMs = 750,
): DebouncedStorage {
  return createBufferedStorage(storage, delayMs)
}

/** Buffer snapshots before JSON encoding, so typing only serializes once per batch. */
export function createDebouncedJSONStorage<State>(
  storage: StateStorage,
  delayMs = 750,
): DebouncedStorage<StorageValue<State>> {
  return createBufferedStorage(createJSONStorage<State>(() => storage)!, delayMs)
}

function createBufferedStorage<Value>(storage: Storage<Value>, delayMs: number): DebouncedStorage<Value> {
  const pending = new Map<string, Value>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const entries = [...pending.entries()]
    pending.clear()
    for (const [name, value] of entries) {
      try {
        storage.setItem(name, value)
      } catch {
        // A storage quota/security error must not interrupt SQL editing.
        pending.set(name, value)
      }
    }
  }

  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, Math.max(0, delayMs))
  }

  return {
    getItem: (name) => pending.has(name) ? pending.get(name)! : storage.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value)
      schedule()
    },
    removeItem: (name) => {
      pending.delete(name)
      try {
        storage.removeItem(name)
      } catch {
        // Keep the in-memory store usable when storage is unavailable.
      }
    },
    flush,
  }
}
