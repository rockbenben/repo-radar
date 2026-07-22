import { Notification } from "electron"
import type { InboxChange } from "../../server/src/backend"

/**
 * 「等我的」新增时的系统通知。
 *
 * 判定与文案是纯函数，Electron 只在最外层出现——通知这种东西不好手动复现（要等真有新 PR），
 * 所以规则必须能被测试钉死。
 *
 * 文案刻意不含任何散文：主进程读不到用户选的界面语言（语言只存在浏览器 localStorage 里），
 * 而「仓库名 + PR +2 · CI ✗」这种形式在任何语言下都读得懂，也就不必为通知再引入一套 i18n。
 *
 * 已知盲区（刻意接受，不去修）：判定用的是计数差而不是 id 集合差。同一轮里如果「合并了 1 个 PR
 * 又新开了 1 个 PR」，前后总数不变，delta 为 0，永远不会提醒——这是按计数而非按 id 集合差分的
 * 必然结果。改成 id 集合差分能修，但要多缓存一份 PR/issue 的 id 列表、多一轮比较逻辑，
 * 对一个「打扰性功能」来说成本收益不成比例，所以不做，只在这里如实记一笔。
 */

export interface NotificationContent {
  title: string
  body: string
}

const MAX_REPOS = 3 // 超出部分折叠成 +N：通知栏宽度有限，列太多等于什么都没说

/** 单个仓库的新增摘要；没有任何「新增」时返回 null */
function summarizeOne(change: InboxChange): string | null {
  // 首次拿到该仓库的缓存：此时全部条目都是「新」的，弹出来等于把历史积压全倒给用户
  if (change.before === null) return null
  const parts: string[] = []
  // byViewer 标记 prs/issues 是否已减去自己开的（true）还是含自己在内（false/undefined）。
  // 两侧口径不同时，计数差不可信——差值里可能整包含着「自己开的」那部分，是虚的，必须跳过：
  // 典型场景是重启后本轮 viewer 查询失败（byViewer 变 false），若仍与上一轮「已减自己」的缓存做差，
  // 全部仓库会同时虚高，登录后立刻弹一条聚合误报。CI 的判定与口径无关，不受此影响，照常走。
  // 注意 undefined !== true 成立，所以旧缓存升级后的第一轮也会被当作「口径不同」跳过计数通知——
  // 这是可接受且更安全的行为：宁可漏一次真实提醒，也不要因为口径切换弹一条虚的
  if (change.before.byViewer === change.after.byViewer) {
    const prs = change.after.prs - change.before.prs
    const issues = change.after.issues - change.before.issues
    if (prs > 0) parts.push(`PR +${prs}`)
    if (issues > 0) parts.push(`Issue +${issues}`)
  }

  // CI 通知逻辑：
  // 1. 原有规则：由通过变失败（pass → fail）
  // 2. 新增规则：ciSha 变了（换了提交），虽然 CI 一直失败，但这是新提交上的新失败，应该提醒
  //    为什么需要区分：一次 CI 失败每 12 分钟轮询一次，如果每次都通知，用户会被频繁打扰
  //    但当别人推了新提交、新提交的 CI 也失败了，这是一个新情况，值得通知一次
  // 注意：ciSha 的类型是 string | null | undefined，旧缓存可能没有此字段
  //    只有当两侧的 ciSha 都存在且不相等时，才判定为「新提交新失败」
  if (change.after.ciFailed) {
    const isCiStatusFlipped = !change.before.ciFailed
    const isNewCommitWithFailure =
      change.before.ciSha &&
      change.after.ciSha &&
      change.before.ciSha !== change.after.ciSha
    if (isCiStatusFlipped || isNewCommitWithFailure) {
      parts.push("CI ✗")
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function summarizeInboxChanges(changes: InboxChange[]): NotificationContent | null {
  const withNews = changes
    .map((c) => ({ name: c.name, text: summarizeOne(c) }))
    .filter((x): x is { name: string; text: string } => x.text !== null)

  if (withNews.length === 0) return null
  // 单个仓库时把名字提到标题，正文只留变化——一眼就知道是哪个仓库的什么事
  if (withNews.length === 1) return { title: withNews[0].name, body: withNews[0].text }

  // 截断到 MAX_REPOS 前先按仓库名排序：changes 的顺序是本轮并发拉取的完成顺序，每轮都可能不同——
  // 不排序的话「截断后留哪 3 个」是不确定的。字典序不追求语义，只要求跨轮次稳定
  const sorted = [...withNews].sort((a, b) => a.name.localeCompare(b.name))
  const shown = sorted.slice(0, MAX_REPOS).map((x) => `${x.name}: ${x.text}`)
  const rest = sorted.length - shown.length
  if (rest > 0) shown.push(`+${rest}`)
  return { title: "repo-radar", body: shown.join(" · ") }
}

/**
 * 弹通知；点击时调 onClick（把面板叫回来）。系统不支持通知时静默跳过。
 * iconPath 由调用方传入（main.ts 里已有 trayIconPath，与托盘图标共用一份资源）——
 * notify.ts 保持纯粹，不在这里硬编码任何文件路径。
 */
export function showNotification(content: NotificationContent, iconPath: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: content.title, body: content.body, icon: iconPath })
  n.on("click", onClick)
  n.show()
}
