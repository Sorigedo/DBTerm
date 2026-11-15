import { useRef, useState } from 'react'

/** Cached editor callbacks may retain their entire render scope. Keep the heavy
 * snapshot in this hook's scope and expose only a current-value container. */
export function useResultState<T>(initial: T) {
  const [value, setValue] = useState(initial)
  const current = useRef(value)
  current.current = value
  return [current, setValue] as const
}

/** Derived result lists must not become strong bindings in the editor scope. */
export function useCurrentResultView<T>(value: T) {
  const current = useRef(value)
  current.current = value
  return current
}
