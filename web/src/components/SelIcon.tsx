/** 顶栏下拉的角色标记：三个 Select 外观相同、值又会变，没有常驻图标就分不清谁是谁。
 *  漏斗=按分组筛选、双向箭头=排序、栅格=分组方式；currentColor 内联 SVG，随主题走 */
export function SelIcon({ kind }: { kind: "filter" | "sort" | "group" }) {
  const path =
    kind === "filter"
      ? "M2 3h12l-4.5 5.2V13l-3-1.5V8.2L2 3Z" // 漏斗
      : kind === "sort"
        ? "M5 3v10M5 13l-2.4-2.6M5 13l2.4-2.6M11 13V3M11 3l-2.4 2.6M11 3l2.4 2.6" // 上下双箭头
        : "M2.5 2.5h4.6v4.6H2.5zM8.9 2.5h4.6v4.6H8.9zM2.5 8.9h4.6v4.6H2.5zM8.9 8.9h4.6v4.6H8.9z" // 四宫格
  return (
    <svg className="rr-sel-ic" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}
