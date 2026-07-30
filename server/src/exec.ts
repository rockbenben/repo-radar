import { spawn } from "node:child_process"

const EXEC_TIMEOUT_MS = 120_000
const OUTPUT_CAP = 4000 // 每仓库保留的输出上限（字符），只留尾部，避免刷屏
// 杀掉 shell 之后最多再等这么久收 'close'。见下面 settle 处的注释：孙进程活着时 'close' 永远不来
const KILL_GRACE_MS = 2_000

export interface ExecResult {
  ok: boolean
  code: number | null
  output: string // stdout + stderr 合并，尾部截断
}

/**
 * 在某个仓库目录下执行一条用户输入的 shell 命令（本地工具、用户主动发起）。
 * shell:true 以支持管道/内置命令；仅监听 127.0.0.1 且 API 有 Origin 校验，命令来源受限于本机面板。
 */
export function runCommand(cwd: string, command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let out = ""
    let killed = false
    let exitCode: number | null = null // 'exit' 先于 'close'；宽限期到点收工时用它当退出码
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null

    /** 唯一的收工出口，幂等。orphaned 表示「shell 已被杀但管道没关」，说明还有子进程活着 */
    const settle = (code: number | null, orphaned: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      const trimmed = (out.length > OUTPUT_CAP ? "…" + out.slice(-OUTPUT_CAP) : out).trim()
      if (!killed) return resolve({ ok: code === 0, code, output: trimmed })
      const note = orphaned ? `[超时 ${timeoutMs}ms 已终止；子进程可能仍在后台运行]` : `[超时 ${timeoutMs}ms 已终止]`
      resolve({ ok: false, code, output: `${trimmed}\n${note}`.trim() })
    }

    const timer = setTimeout(() => {
      killed = true
      child.kill()
      // child.kill() 杀的是 shell —— shell:true 下真正的命令是它的**子**进程，会继承同一对 stdio
      // 管道。孙进程活下来时管道不关，'close' 就永远不来（'exit' 照常来）。只等 'close' 的话这个
      // promise 永不 settle，而调用方是 withRepoLock(id, () => runCommand(...))：该仓库的锁链从此
      // 永久阻塞，之后所有 git 操作都排在一个不会完成的 promise 后面，批量任务永远不 finished，
      // 退出时 drainRepoLocks 每次等满 10 秒还要误报「可能残留 index.lock」。
      // 因此给一个宽限期：'close' 来了就照常收（输出完整），不来就如实收工并说明子进程可能还活着。
      graceTimer = setTimeout(() => settle(exitCode, true), KILL_GRACE_MS)
    }, timeoutMs)
    const append = (d: string) => {
      out += d
      if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2) // 边收边裁，防止内存膨胀
    }
    // setEncoding 走 StringDecoder：中文构建日志跨 chunk 边界不会两头解成乱码（逐 chunk toString 会）
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    // 管道自身的 error 要有人听，否则 cwd 超过 MAX_PATH 时 Node 把它升级成 uncaughtException（见 git.ts 的 runGit）
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("exit", (code) => (exitCode = code))
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      resolve({ ok: false, code: null, output: `无法执行：${err.message}` })
    })
    child.on("close", (code) => settle(code, false))
  })
}
