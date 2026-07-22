// RootsEditor 弹窗"打开时拉取 config.roots"这段逻辑的纯函数版本——抽出来是因为 web/ 目前
// 没有组件渲染测试基建（无 jsdom/RTL），没法直接挂载 RootsEditor 断言它的 DOM，只能测纯函数。

export type RootsLoadResult = { status: "loaded"; roots: string[] } | { status: "error"; message: string }

/**
 * 拉取当前配置的 roots。三种失败（HTTP 非 2xx、网络层抛错、JSON 解析失败）统一归为 error 态——
 * 调用方（RootsEditor 的 effect）不该把任何一种误当成「加载成功、只是空列表」，
 * 那样会在请求失败时悄悄把弹窗渲染成"没有任何扫描目录"，跟用户已保存的配置对不上。
 */
export async function loadRoots(fetchImpl: typeof fetch): Promise<RootsLoadResult> {
  try {
    const r = await fetchImpl("/api/config")
    if (!r.ok) return { status: "error", message: `HTTP ${r.status}` }
    const c = (await r.json()) as { roots?: unknown }
    const roots = Array.isArray(c.roots) ? (c.roots as string[]) : []
    return { status: "loaded", roots }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
}
