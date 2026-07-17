import type { HeatmapDay } from "../types"
import { ymd } from "./time"

export interface HeatCell {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

function toLevel(count: number): HeatCell["level"] {
  if (count <= 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}


export function buildHeatmapGrid(days: HeatmapDay[], weeks: number, endDate: Date): HeatCell[][] {
  const counts = new Map(days.map((d) => [d.date, d.count]))
  // 定位 endDate 所在周的周日，再回退 weeks-1 周作为第一列
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
  const lastSunday = new Date(end)
  lastSunday.setDate(end.getDate() - end.getDay())
  const grid: HeatCell[][] = []
  for (let w = weeks - 1; w >= 0; w--) {
    const col: HeatCell[] = []
    for (let dow = 0; dow < 7; dow++) {
      const cell = new Date(lastSunday)
      cell.setDate(lastSunday.getDate() - w * 7 + dow)
      const date = ymd(cell)
      const count = cell > end ? 0 : (counts.get(date) ?? 0)
      col.push({ date, count, level: cell > end ? 0 : toLevel(count) })
    }
    grid.push(col)
  }
  return grid
}
