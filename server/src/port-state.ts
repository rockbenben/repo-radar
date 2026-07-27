import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 记住「上一次实际绑定的端口」，仅在发生过端口回退时写入。
 *
 * 存在的理由不是省一次 bind，而是**窗口 origin 的稳定性**：界面是网页，
 * `http://127.0.0.1:{port}` 里的端口是 origin 的一部分，端口一变就是另一个 origin，
 * localStorage 整个换一套。而前端把用户数据存在那里——保存的视图、活动日志、已忽略项、
 * 主题、语言。系统保留区间会随重启漂移，于是「这次 17420 被占→18420，下次又空出来→17420」
 * 会让用户的视图和日志在两个 origin 之间来回消失又出现，界面上没有任何解释。
 *
 * 因此一旦被迫搬家就记下来，之后优先用记住的那个：**一次冲突永久搬家，好过每次重启横跳**。
 * 代价是原端口空出来后不会自动搬回去——这是刻意的，origin 稳定比端口好看重要；
 * 实际用的端口在设置面板里能看到，想搬回去删掉这个文件即可。
 *
 * 与 version-state 一样：读不出来（缺失/损坏）统一按「没记住」处理，最坏后果只是重新走一遍
 * 回退阶梯，无害。日志/状态文件绝不能成为故障源。
 */

export function loadRememberedPort(file: string): number | null {
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown }
    const n = raw.port
    return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
  } catch {
    return null
  }
}

export function saveRememberedPort(file: string, port: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ port }, null, 2), "utf8")
  } catch {
    /* 写不进去顶多下次重走阶梯，不能反过来把启动搞挂 */
  }
}

/** 回到了原本想要的端口，就把记录抹掉——否则一次偶发冲突会被永久固化下来 */
export function forgetRememberedPort(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 同上 */
  }
}
