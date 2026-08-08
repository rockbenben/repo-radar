// 顶栏告警灯的显示偏好：存的是**关掉的**那几盏（逗号分隔，读写见 App.tsx 的 pref/savePref）。
// 抽成纯函数是为了能不挂载整个 App 就测——App.tsx 拉进 antd 和全部组件，为几行字符串逻辑
// 起一个 jsdom + 假 WebSocket + 五个 fetch 端点的壳子不划算（同 lib/scanConfig.ts 的理由）。

/**
 * 关掉的 key → 该显示哪几盏灯。
 *
 * 存「关掉的」而不是「开着的」，因为白名单会把偏好冻结在写入那一刻的灯集合上：
 * 以后版本给 ATTENTION 加第七盏灯，所有老用户的 localStorage 里都没有它，新告警永远不亮，
 * 只有全新的浏览器配置才看得见。黑名单没有这个问题——没被显式关掉的灯默认就是亮的。
 *
 * 顺序始终跟随 all：灯的排列由代码定，不由用户勾选的先后定。
 * 空串（没设置过 / 一盏都没关）解出全亮；all 全在 off 里则一盏不亮，两端都是合法状态。
 */
export function visibleLamps<K extends string>(off: string, all: readonly K[]): K[] {
  const hidden = new Set(off.split(","))
  return all.filter((k) => !hidden.has(k))
}
