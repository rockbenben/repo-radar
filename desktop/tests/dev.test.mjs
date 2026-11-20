import { once } from "node:events"
import { createServer } from "node:net"
import { expect, it, vi } from "vitest"
import { runDev } from "../scripts/dev.mjs"

vi.mock("electron", () => ({ default: "unused-electron" }))

async function reservePort() {
  const socket = createServer().listen(0, "127.0.0.1")
  await once(socket, "listening")
  const { port } = socket.address()
  return { port, close: () => new Promise((resolve) => socket.close(resolve)) }
}

it("fails on an occupied Vite port before spawning Electron", async () => {
  const { port, close } = await reservePort()
  const launch = vi.fn(() => 0)
  try {
    await expect(runDev({ port, launch })).rejects.toThrow(/already in use/i)
    expect(launch).not.toHaveBeenCalled()
  } finally {
    await close()
  }
})

it("serves the actual Web app before starting Electron and closes Vite when Electron exits", async () => {
  const { port, close } = await reservePort()
  await close()
  const url = `http://127.0.0.1:${port}/`
  const launch = vi.fn(async () => {
    const response = await fetch(url)
    expect(response.ok).toBe(true)
    expect(await response.text()).toContain('id="root"')
    return 7
  })
  await expect(runDev({ port, launch })).resolves.toBe(7)
  expect(launch).toHaveBeenCalledOnce()
  await expect(fetch(url)).rejects.toThrow()
})
