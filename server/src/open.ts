import { spawn } from "node:child_process"

export function buildOpenCommand(template: string, path: string): string {
  return template.replaceAll("{path}", path)
}

/** 启动外部程序（编辑器/终端/资源管理器）：分离进程，立即返回，失败仅记日志 */
export function openTarget(template: string, path: string): void {
  const command = buildOpenCommand(template, path)
  try {
    const child = spawn(command, { shell: true, detached: true, stdio: "ignore" })
    child.on("error", (err) => console.error(`[repo-radar] 打开失败：${err.message}`))
    child.unref()
  } catch (err) {
    console.error(`[repo-radar] 打开失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
