/// <reference lib="es2021.weakref" />
/** Identity must not become an extra strong owner of a potentially large result. */
export function createResultOwner<T extends object>() {
  let owner: WeakRef<T> | null = null
  return {
    set(result: T) { owner = new WeakRef(result) },
    clear() { owner = null },
    matches(result: T | null | undefined) {
      return result != null && owner?.deref() === result
    },
  }
}
