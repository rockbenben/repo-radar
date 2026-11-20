import type {} from "vitest/jsdom"
import { afterAll } from "vitest"

// Vitest sees Node's native storage globals before it copies the jsdom window.
// Use the browser storage objects so tests share jsdom's per-origin state.
if (typeof jsdom !== "undefined") {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value: jsdom.window[key], configurable: true, writable: true })
    afterAll(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
}
