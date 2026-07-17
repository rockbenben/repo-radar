import { gt } from "../i18n"
import { buildHeatmapGrid } from "../lib/heatmap"
import type { HeatmapDay } from "../types"

// 1..4 级走 CSS 变量，随深/浅主题切换：深底=暗绿→亮绿，白底=浅绿→深绿（否则暗绿在白底成脏斑块）；0 级（空）同样走变量
const LEVEL_COLORS = ["", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"]

// fill：让各列等分容器宽度、铺满不溢出（弹窗里用，永不出横向滚动条）；不传则用固定 11px 格子（统计页大范围时可横向滚动）
export function Heatmap({ days, weeks = 53, legend = false, fill = false }: { days: HeatmapDay[]; weeks?: number; legend?: boolean; fill?: boolean }) {
  const grid = buildHeatmapGrid(days, weeks, new Date())
  return (
    <div className="rr-heat-wrap">
      <div className={`rr-heat${fill ? " fill" : ""}`}>
        {grid.map((col, i) => (
          <div key={i} className="col">
            {col.map((cell) => (
              <div
                key={cell.date}
                className={`cell${cell.level === 0 ? " empty" : ""}`}
                title={`${cell.date} · ${cell.count}`}
                style={cell.level === 0 ? undefined : { background: LEVEL_COLORS[cell.level] }}
              />
            ))}
          </div>
        ))}
      </div>
      {legend && (
        <div className="rr-heat-legend">
          <span className="lbl">{gt("detail.heatLess")}</span>
          <span className="cell empty" />
          {[1, 2, 3, 4].map((l) => (
            <span key={l} className="cell" style={{ background: LEVEL_COLORS[l] }} />
          ))}
          <span className="lbl">{gt("detail.heatMore")}</span>
        </div>
      )}
    </div>
  )
}
