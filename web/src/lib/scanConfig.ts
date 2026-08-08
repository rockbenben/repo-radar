// ScanConfigEditor 弹窗"打开时拉取配置"这段逻辑的纯函数版本：解析与容错在这里，
// 不必挂载组件、也不必造五个 fetch 端点就能把三种失败态和字段缺失都测到。

export type OpenCommands = { editor: string; terminal: string; explorer: string }
export type ScanConfig = { roots: string[]; excludes: string[]; open: OpenCommands }
export type ScanConfigLoadResult = ({ status: "loaded" } & ScanConfig) | { status: "error"; message: string }

// 数组里的元素**不过滤**：弹窗显示什么，保存时就整份写回哪些（mergeConfig 对 roots/excludes
// 是整体替换）。手改坏的 config.json 里混进一个 null，悄悄滤掉它等于点一次保存就把它从磁盘上
// 永久删了，无提示无备份；原样带回去只会被服务端的 validateConfigPatch 拒成 400——
// 用户看得见错误，文件也还在
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
// 缺字段/类型不对时回落空串而不是默认命令：这里显示什么，保存时就会原样写回配置。
// 编回一条「猜的」默认命令会把用户手改过、只是这次没读到的设置无声覆盖掉
const str = (v: unknown): string => (typeof v === "string" ? v : "")

/**
 * 排除项归一成末段目录名。
 *
 * 扫描端按**目录名**匹配（server/src/scanner.ts 是 `excludeSet.has(entry.name)`），
 * 而用户最顺手的输入是从资源管理器粘一条完整路径、或者带着末尾分隔符。原样存下去
 * 界面上像是排除成功了，扫描却照进不误——一个不报错也不生效的设置最难查。
 * 大小写不动：Linux 上目录名本来就区分大小写，折叠掉是错的。
 */
export function dirName(value: string): string {
  return value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
}

/**
 * 拉取弹窗要编辑的那部分配置。三种失败（HTTP 非 2xx、网络层抛错、JSON 解析失败）统一归为 error 态——
 * 调用方（ScanConfigEditor 的 effect）不该把任何一种误当成「加载成功、只是空列表」，
 * 那样会在请求失败时悄悄把弹窗渲染成"没有任何扫描目录"，跟用户已保存的配置对不上。
 */
export async function loadScanConfig(fetchImpl: typeof fetch): Promise<ScanConfigLoadResult> {
  try {
    const r = await fetchImpl("/api/config")
    if (!r.ok) return { status: "error", message: `HTTP ${r.status}` }
    const c = (await r.json()) as { roots?: unknown; excludes?: unknown; open?: Record<string, unknown> }
    const open = c.open ?? {}
    return {
      status: "loaded",
      roots: strings(c.roots),
      excludes: strings(c.excludes),
      open: { editor: str(open.editor), terminal: str(open.terminal), explorer: str(open.explorer) },
    }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
}
