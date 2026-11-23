import { App, Button } from "antd"
import { useEffect, useState } from "react"
import { useI18n } from "../i18n"
import type { WorklogExportStatus } from "../types"

const URL = "/api/worklog/export"

function readStatus(value: unknown): WorklogExportStatus {
  const status = value as WorklogExportStatus | null
  if (typeof status?.archiveDir !== "string" || (status.pendingDates !== null && !Array.isArray(status.pendingDates))) {
    throw new Error("Invalid worklog export status")
  }
  return status
}

export function WorklogExportStatusPanel({ disabled }: { disabled: boolean }) {
  const { t, lang } = useI18n()
  const { message } = App.useApp()
  const [status, setStatus] = useState<WorklogExportStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [manualRunning, setManualRunning] = useState(false)

  useEffect(() => {
    if (manualRunning) return
    const controller = new AbortController()
    let timer: number | undefined

    async function load() {
      try {
        const response = await fetch(URL, { signal: controller.signal, cache: "no-store" })
        if (!response.ok) throw new Error()
        const result = readStatus(await response.json())
        if (!controller.signal.aborted) {
          setStatus(result)
          setUnavailable(false)
        }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true)
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(load, 5000)
      }
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [manualRunning])

  async function exportNow() {
    setManualRunning(true)
    try {
      const response = await fetch(URL, { method: "POST" })
      if (!response.ok) throw new Error()
      const result = (await response.json()) as { success: boolean; status: WorklogExportStatus }
      setStatus(readStatus(result.status))
      if (result.success) message.success(t("settings.worklogExportDone"))
      else message.error(t("settings.worklogExportFailed"))
    } catch {
      message.error(t("settings.worklogExportFailed"))
    } finally {
      setManualRunning(false)
    }
  }

  const dateLabel = (date: string) => new Date(date).toLocaleString(lang, { hour12: false })
  return (
    <div className="row stack rr-worklog-export-status">
      <Button
        size="small"
        onClick={() => void exportNow()}
        loading={manualRunning || status?.running === true}
        disabled={disabled || unavailable || !status?.ready}
      >
        {t("settings.worklogExportNow")}
      </Button>
      {unavailable ? <span className="muted" role="status">{t("settings.worklogStatusUnavailable")}</span> : status ? (
        <dl>
          <dt>{t("settings.worklogArchiveDir")}</dt>
          <dd><code dir="ltr">{status.archiveDir}</code></dd>
          <dt>{t("settings.worklogLastSuccess")}</dt>
          <dd>{status.lastSuccessAt ? <time dateTime={status.lastSuccessAt}>{dateLabel(status.lastSuccessAt)}</time> : "—"}</dd>
          <dt>{t("settings.worklogPendingDates")}</dt>
          <dd>
            {status.pendingDates === null ? t("settings.worklogStatusUnavailable") : status.pendingDates.length === 0 ? "0" : (
              <details>
                <summary>{status.pendingDates.length.toLocaleString(lang)}</summary>
                <ul dir="ltr">{status.pendingDates.map((day) => <li key={day}><time dateTime={day}>{day}</time></li>)}</ul>
              </details>
            )}
          </dd>
          <dt>{t("settings.worklogLastFailure")}</dt>
          <dd>
            {status.lastFailure ? (
              <>
                <time dateTime={status.lastFailure.at}>{dateLabel(status.lastFailure.at)}</time>
                <div>{status.lastFailure.reason}</div>
              </>
            ) : "—"}
          </dd>
        </dl>
      ) : <span className="muted" role="status">{t("common.loading")}</span>}
    </div>
  )
}
