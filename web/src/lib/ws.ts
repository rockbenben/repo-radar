import type { ServerEvent } from "../types"

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
