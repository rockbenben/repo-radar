// 主区域「空状态/欢迎块」该不该渲染、渲染哪一支，从 App.tsx 内联逻辑里抽出来——
// 抽成纯函数才好在不搭 React Testing Library 的情况下单测（本仓库 web/ 目前没有组件渲染测试基建）。

/**
 * hasRoots 的三态：
 *   - null：挂载时的 GET /api/config 还没返回（成功或失败都还不知道）。
 *   - "unknown"：那次请求已经返回但失败了（网络错误、后端还在跑启动扫描时的连接被重置等）。
 *   - boolean：请求成功，是否已配置过扫描来源的确切结果。
 */
export type HasRootsState = boolean | null | "unknown"

export type EmptyAreaState =
  | "hidden" // 让位给别处的状态展示（loadError/scanning），或已有仓库卡片可看，这块不必渲染
  | "loading" // hasRoots 还没拉到：中性加载态，绝不能被当成「首次运行」展示欢迎文案
  | "configError" // hasRoots 请求确实失败了：明确的错误 + 重试/设置入口，不能冒充欢迎页，也不能悄悄假装「未配置」
  | "welcome" // 确知没配置过扫描来源：首次运行引导
  | "list" // 已知配置过（或已有仓库）：交给「未发现仓库/无匹配」的按视图过滤判断

/**
 * 主区域该渲染哪一支。三条不变式：
 *   1. loadError/scanning 时让位（各自有专门的状态展示）；
 *   2. 只要还有卡片在渲染（reposCount>0），这块不必再判断 hasRoots——已经不是「一片空白」；
 *   3. reposCount===0 时必须明确交代 hasRoots 的三态之一，不能因为「不确定」就什么都不显示，
 *      也不能把「加载中」「加载失败」都含糊地当成「首次运行」——只有确知 hasRoots===false 才走欢迎页。
 */
export function resolveEmptyArea(params: { loadError: string | null; scanning: boolean; hasRoots: HasRootsState; reposCount: number }): EmptyAreaState {
  if (params.loadError !== null || params.scanning) return "hidden"
  if (params.reposCount > 0) return "list"
  if (params.hasRoots === null) return "loading"
  if (params.hasRoots === "unknown") return "configError"
  return params.hasRoots ? "list" : "welcome"
}
