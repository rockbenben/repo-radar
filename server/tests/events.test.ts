import { describe, expect, it } from "vitest"
import { WsHub, type WsClient } from "../src/events"

function fakeClient(): WsClient & { received: string[] } {
  const received: string[] = []
  return { received, send: (d: string) => { received.push(d) } }
}

describe("WsHub", () => {
  it("broadcasts JSON envelopes to all clients", () => {
    const hub = new WsHub()
    const a = fakeClient()
    const b = fakeClient()
    hub.add(a)
    hub.add(b)
    hub.broadcast("repo:updated", { x: 1 })
    expect(JSON.parse(a.received[0])).toEqual({ type: "repo:updated", payload: { x: 1 } })
    expect(b.received).toHaveLength(1)
  })

  it("drops clients whose send throws", () => {
    const hub = new WsHub()
    const bad: WsClient = { send: () => { throw new Error("gone") } }
    const good = fakeClient()
    hub.add(bad)
    hub.add(good)
    hub.broadcast("x", {})
    expect(hub.size).toBe(1)
    expect(good.received).toHaveLength(1)
  })

  it("remove is idempotent", () => {
    const hub = new WsHub()
    const c = fakeClient()
    hub.add(c)
    hub.remove(c)
    hub.remove(c)
    expect(hub.size).toBe(0)
  })
})
