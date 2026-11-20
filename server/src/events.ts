import type { ServerEventPayloads } from "./types"

export interface WsClient {
  send(data: string): void
}

export class WsHub {
  private clients = new Set<WsClient>()

  add(client: WsClient): void {
    this.clients.add(client)
  }

  remove(client: WsClient): void {
    this.clients.delete(client)
  }

  broadcast<Type extends keyof ServerEventPayloads>(type: Type, payload: ServerEventPayloads[Type]): void {
    const message = JSON.stringify({ type, payload })
    for (const client of this.clients) {
      try {
        client.send(message)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  get size(): number {
    return this.clients.size
  }
}
