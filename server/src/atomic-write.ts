import { renameSync } from "node:fs"

/**
 * Windows 上杀软/索引器可能短暂占住刚写完的 .tmp，rename 会返回 EPERM/EBUSY；
 * 让出几毫秒有限重试，别把一次正常保存变成失败。POSIX 上通常一次就过。
 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY")) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}
