/** @vitest-environment jsdom */
import type {} from "vitest/jsdom"
import { expect, it } from "vitest"

it("uses the DOM's local and session storage with the same browser origin", () => {
  expect(globalThis.localStorage).toBe(jsdom.window.localStorage)
  expect(globalThis.sessionStorage).toBe(jsdom.window.sessionStorage)
  localStorage.setItem("example", "local")
  sessionStorage.setItem("example", "session")
  expect(window.localStorage.getItem("example")).toBe("local")
  expect(window.sessionStorage.getItem("example")).toBe("session")
  localStorage.clear()
  sessionStorage.clear()
})
