import { type SpawnOptions, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path"
import { DEFAULT_CONFIG } from "./config"

export type OpenTarget = keyof typeof DEFAULT_CONFIG.open

export function parseOpenCommand(template: string, path: string): { file: string; args: string[] } {
  const tokens: string[] = []
  if (/[\r\n\0]/.test(template)) throw new Error("Open command must be a single line")
  let rest = template.trim()
  while (rest !== "") {
    const token = /^(?:"[^"]*"|'[^']*'|[^\s"'|&;<>()`]+)+/.exec(rest)?.[0]
    if (!token) throw new Error("Enter an executable and arguments without shell operators")
    rest = rest.slice(token.length)
    if (rest !== "" && !/^\s/.test(rest)) throw new Error("Enter an executable and arguments without shell operators")
    rest = rest.trimStart()
    tokens.push([...token.matchAll(/"([^"]*)"|'([^']*)'|([^"']+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).join(""))
  }
  const [file, ...args] = tokens
  if (!file || file.includes("{path}")) throw new Error("Open command needs a fixed executable")
  return { file, args: args.map((arg) => arg.replaceAll("{path}", () => path)) }
}

const LAUNCH_GRACE_MS = 750

function launch(file: string, args: string[], options: Pick<SpawnOptions, "cwd" | "env" | "windowsVerbatimArguments"> = {}, checkExit = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, shell: false, detached: true, stdio: "ignore", windowsHide: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = () => {
      child.unref()
      resolve()
    }
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("spawn", () => {
      if (checkExit) timer = setTimeout(started, LAUNCH_GRACE_MS)
      else started()
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Launcher exited with ${signal ?? code}`))
    })
  })
}

function searchPath(): string[] {
  return (process.env.PATH ?? "").split(delimiter).map((dir) => dir.replace(/^"|"$/g, "")).filter(isAbsolute)
}

function windowsCode(): string {
  const candidates = searchPath()
    .flatMap((dir) => existsSync(join(dir, "code.cmd")) ? [join(dir, "Code.exe"), join(dir, "..", "Code.exe")] : [join(dir, "Code.exe")])
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"))
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"))
  return candidates.find(existsSync) ?? "Code.exe"
}

function findBatchFile(file: string, extensions: string[]): string | undefined {
  const dirs = file === basename(file) ? searchPath() : [""]
  return dirs.flatMap((dir) => extensions.map((ext) => resolve(dir, file + ext))).find(existsSync)
}

function launchBatch(file: string, args: string[]): Promise<void> {
  const values = [file, ...args]
  if (values.some((value) => /["\r\n\0]/.test(value))) {
    throw new Error("Windows batch launcher arguments cannot include double quotes or control characters")
  }
  const env = { ...process.env }
  // Pass values via single-pass expansion with delayed expansion disabled.
  // The command line contains fixed placeholders, never the repository path.
  const tokens = values.map((value, index) => {
    const key = `REPO_RADAR_OPEN_${index}`
    env[key] = value
    return `"%${key}%"`
  })
  const cmd = process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
  return launch(cmd, ["/d", "/s", "/v:off", "/c", `"${tokens.join(" ")}"`], { env, windowsVerbatimArguments: true })
}

async function launchWindows(file: string, args: string[]): Promise<void> {
  if (/\.(bat|cmd)$/i.test(file)) {
    const batch = findBatchFile(file, [""])
    if (!batch) throw new Error(`Windows batch launcher not found: ${file}`)
    return launchBatch(batch, args)
  }
  try {
    await launch(file, args)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || extname(file)) throw err
    const batch = findBatchFile(file, [".bat", ".cmd"])
    if (!batch) throw err
    await launchBatch(batch, args)
  }
}

export async function openTarget(
  template: string,
  path: string,
  target: OpenTarget,
  openDirectory?: (path: string) => Promise<string>,
): Promise<void> {
  if (template.trim() !== DEFAULT_CONFIG.open[target]) {
    const { file, args } = parseOpenCommand(template, path)
    return process.platform === "win32" ? launchWindows(file, args) : launch(file, args)
  }

  const platform = process.platform
  if (target === "editor") return launch(platform === "win32" ? windowsCode() : "code", [path])
  if (target === "explorer") {
    if (openDirectory) {
      const error = await openDirectory(path)
      if (error) throw new Error(error)
      return
    }
    if (platform === "win32") return launch("explorer.exe", [path], {}, false)
    return launch(platform === "darwin" ? "open" : "xdg-open", [path])
  }
  if (platform === "win32") return launch("wt.exe", ["-d", path])
  if (platform === "darwin") return launch("open", ["-a", "Terminal", path])
  for (const [file, ...args] of [
    ["xdg-terminal-exec"], ["x-terminal-emulator"], ["gnome-terminal", "--working-directory", path], ["konsole", "--workdir", path], ["xterm"],
  ]) {
    try {
      return await launch(file, args, { cwd: path })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  throw new Error("No supported terminal found. Set a terminal command in settings.")
}
