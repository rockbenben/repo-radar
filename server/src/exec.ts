import { spawn } from "node:child_process"

const EXEC_TIMEOUT_MS = 120_000
const OUTPUT_CAP = 4000 // 每仓库保留的输出上限（字符），只留尾部，避免刷屏

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
    const timer = setTimeout(() => {
      killed = true
      child.kill()
    }, timeoutMs)
    const append = (d: string) => {
      out += d
      if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2) // 边收边裁，防止内存膨胀
    }
    // setEncoding 走 StringDecoder：中文构建日志跨 chunk 边界不会两头解成乱码（逐 chunk toString 会）
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, output: `无法执行：${err.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const trimmed = (out.length > OUTPUT_CAP ? "…" + out.slice(-OUTPUT_CAP) : out).trim()
      if (killed) resolve({ ok: false, code, output: `${trimmed}\n[超时 ${timeoutMs}ms 已终止]`.trim() })
      else resolve({ ok: code === 0, code, output: trimmed })
    })
  })
}
