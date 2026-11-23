/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { App } from "antd"
import { afterEach, expect, it, vi } from "vitest"
import { WorklogExportStatusPanel } from "../src/components/WorklogExportStatus"
import { I18nProvider } from "../src/i18n"
import type { WorklogExportStatus } from "../src/types"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("shows the archive status and updates it after exporting from the settings panel", async () => {
  let status: WorklogExportStatus = {
    archiveDir: "/exports/archive",
    ready: true,
    running: false,
    pendingDates: ["2026-07-15"],
    lastSuccessAt: null,
    lastFailure: { at: "2026-07-15T12:00:00.000Z", reason: "Permission denied" },
  }
  const request = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== "POST") return Response.json(status)
    status = { ...status, pendingDates: [], lastSuccessAt: "2026-07-15T13:00:00.000Z" }
    return Response.json({ success: true, status })
  })
  vi.stubGlobal("fetch", request)
  render(
    <I18nProvider lang="en" setLang={() => {}}>
      <App><WorklogExportStatusPanel disabled={false} /></App>
    </I18nProvider>,
  )

  expect(await screen.findByText("/exports/archive")).toBeTruthy()
  expect(screen.getByText("Permission denied")).toBeTruthy()
  fireEvent.click(screen.getByText("1"))
  expect(screen.getByText("2026-07-15")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Export now" }))
  expect(await screen.findByText("Worklog export completed.")).toBeTruthy()
  expect(request).toHaveBeenCalledWith("/api/worklog/export", { method: "POST" })
  expect(screen.getByText("0")).toBeTruthy()
  expect(screen.getByText("Permission denied")).toBeTruthy()
})
