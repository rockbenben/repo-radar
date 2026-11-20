import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import electronPath from "electron"
import { createServer } from "vite"

const desktopRoot = fileURLToPath(new URL("..", import.meta.url))
const webRoot = fileURLToPath(new URL("../../web", import.meta.url))

async function launchElectron(signal) {
  const child = spawn(electronPath, ["."], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: { ...process.env, REPO_RADAR_DEV: "1" },
    signal,
  })
  const [status] = await once(child, "close")
  return status ?? (signal?.aborted ? 130 : 1)
}

export async function runDev({ port, launch = launchElectron, signal } = {}) {
  const vite = await createServer({ root: webRoot, server: port === undefined ? {} : { port } })
  try {
    await vite.listen()
    vite.printUrls()
    if (signal?.aborted) return 130
    return await launch(signal)
  } finally {
    await vite.close()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    process.exitCode = await runDev({ signal: controller.signal })
  } catch (err) {
    if (!controller.signal.aborted) console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = controller.signal.aborted ? 130 : 1
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}
