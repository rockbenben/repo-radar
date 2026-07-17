import type { BatchProgress, RepoStatus } from "../types"

export type ServerEvent =
  | { type: "repo:updated"; payload: { repo: RepoStatus } }
  | { type: "batch:progress"; payload: BatchProgress }
  | { type: "scan:progress"; payload: { scanned: number; total: number } }

const RECONNECT_MS = 3000

export function connectEvents(onEvent: (e: ServerEvent) => void, onConnect?: () => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let timer: number | undefined

  const open = (): void => {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onopen = () => {
      onConnect?.()
    }
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as ServerEvent)
      } catch {
        // 忽略无法解析的消息
      }
    }
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(open, RECONNECT_MS)
    }
  }

  open()
  return () => {
    closed = true
    window.clearTimeout(timer)
    ws?.close()
  }
}
