import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { format } from "node:util"

/**
 * 日志落盘。存在的理由很具体：开机自启起来的进程，stdout 无处可去——
 * Windows 的 Run 键、没配 StandardOutPath 的 launchd、XDG autostart 都是直接丢弃。
 * 「登录后静默服务」于是等于「出任何问题都零线索」，而这恰恰是最难让用户自己复现的场景。
 *
 * 刻意做得很小：同步 append（进程被硬杀也不会丢已写内容，不需要 flush，也就不必挂进退出流程）、
 * 按大小轮转一份备份（上限 1 MB，长期跑的服务不能让日志无界增长）、写盘失败一律吞掉——
 * 日志是诊断手段，它自己绝不能成为故障源。
 */

const MAX_BYTES = 1024 * 1024

/** 日志文件路径：与 config 同目录下的 logs/（跟随 REPO_RADAR_CONFIG） */
export function logFilePath(configDir: string): string {
  return join(configDir, "logs", "repo-radar.log")
}

/** 单行格式：ISO 时间 + 级别 + 正文。console 那边的行已经自带 [repo-radar] 前缀，这里不再重复加 */
export function formatLine(level: "log" | "error", text: string, now: Date): string {
  return `${now.toISOString()} ${level === "error" ? "ERR" : "LOG"} ${text}\n`
}

export class FileLog {
  constructor(
    private readonly file: string,
    private readonly maxBytes: number = MAX_BYTES,
  ) {}

  /** 超过上限就把当前文件轮转成 .1（覆盖上一份备份），新日志从空文件开始 */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return
      const backup = `${this.file}.1`
      rmSync(backup, { force: true }) // Windows 的 rename 不覆盖已存在的目标
      renameSync(this.file, backup)
    } catch {
      /* 轮转失败就继续往原文件写，总比丢日志强 */
    }
  }

  write(level: "log" | "error", text: string, now = new Date()): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.file, formatLine(level, text, now), "utf8")
    } catch {
      /* 磁盘满/只读目录：日志绝不能反过来把服务搞挂 */
    }
  }
}

/**
 * 把 console 的输出同时抄一份到文件。选择包装 console 而不是全项目换成 log()：
 * 现有调用点分散在十几个模块里，包装一层能连带捕获三方库写到 console 的内容，
 * 且不会有人新加一行 console.log 就漏进日志。返回还原函数，测试用。
 */
export function installConsoleTee(log: FileLog): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const tee =
    (level: "log" | "error", orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      orig(...args)
      log.write(level, format(...args))
    }
  console.log = tee("log", original.log)
  console.warn = tee("error", original.warn)
  console.error = tee("error", original.error)
  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
