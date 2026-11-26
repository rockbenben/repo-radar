/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react"
import { App as AntApp, ConfigProvider } from "antd"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { I18nProvider } from "../src/i18n"
import { ymd } from "../src/lib/time"

class FakeWebSocket {
  static last: FakeWebSocket
  onmessage: ((event: { data: string }) => void) | null = null

  constructor() {
    FakeWebSocket.last = this
  }

  close() {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

it.each([
  { view: "stats", transport: "WebSocket", before: "Recently active", after: "Updated project" },
  { view: "worklog", transport: "WebSocket", before: "No commits in this period.", after: "Updated commit" },
  { view: "stats", transport: "HTTP", before: "Recently active", after: "Updated project" },
])("refreshes the saved $view view on scan completion via $transport", async ({ view, transport, before, after }) => {
  window.localStorage.setItem("rr.view", view)
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  let scanned = false
  const scanTime = "2026-07-02T00:00:00Z"
  let finishScan!: (response: Response) => void
  const scan = new Promise<Response>((resolve) => { finishScan = resolve })
  const today = ymd(new Date())
  vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
    if (input === "/api/scan" && options?.method === "POST") return scan
    if (input === "/api/scan") return Response.json({ lastScanAt: scanned ? scanTime : null })
    if (input.startsWith("/api/stats/heatmap")) return Response.json({ days: [] })
    if (input === "/api/stats/activity") {
      return Response.json({ repos: scanned ? [{
        id: "repo", name: "Updated project", displayName: null,
        lastActivityDate: new Date().toISOString(), lastCommitDate: new Date().toISOString(),
      }] : [] })
    }
    if (input.startsWith("/api/worklog?")) {
      return Response.json({ commits: scanned ? [{
        repoId: "repo", repoName: "project", repoDir: "project", hash: "abc123",
        day: today, time: "09:00", subject: "Updated commit", author: "A", authorEmail: "a@example.invalid",
      }] : [] })
    }
    return Response.json({})
  }))

  render(
    <ConfigProvider>
      <I18nProvider lang="en" setLang={() => {}}>
        <AntApp><App themePreference="dark" onThemeChange={() => {}} /></AntApp>
      </I18nProvider>
    </ConfigProvider>,
  )
  expect(await screen.findByText(before)).toBeTruthy()
  scanned = true
  await act(async () => {
    if (transport === "WebSocket") {
      FakeWebSocket.last.onmessage?.({
        data: JSON.stringify({ type: "scan:done", payload: { at: scanTime, repos: [] } }),
      })
    } else {
      finishScan(Response.json([], { headers: { "X-Repo-Radar-Scan-At": scanTime } }))
    }
  })
  expect(await screen.findByText(after)).toBeTruthy()
})
