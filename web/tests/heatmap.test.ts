import { describe, expect, it } from "vitest"
import { buildHeatmapGrid } from "../src/lib/heatmap"

const END = new Date("2026-07-14T00:00:00") // 周二

describe("buildHeatmapGrid", () => {
  it("produces weeks x 7 grid ending at endDate's week", () => {
    const grid = buildHeatmapGrid([], 4, END)
    expect(grid).toHaveLength(4)
    expect(grid.every((col) => col.length === 7)).toBe(true)
    const lastCol = grid[3]
    expect(lastCol[0].date).toBe("2026-07-12") // 该周周日
    expect(lastCol[2].date).toBe("2026-07-14") // endDate 本身
  })
  it("maps counts to levels", () => {
    const grid = buildHeatmapGrid(
      [
        { date: "2026-07-13", count: 1 },
        { date: "2026-07-12", count: 4 },
        { date: "2026-07-08", count: 7 },
        { date: "2026-07-07", count: 12 },
      ],
      2,
      END,
    )
    const flat = grid.flat()
    const byDate = (d: string) => flat.find((c) => c.date === d)!
    expect(byDate("2026-07-13").level).toBe(1)
    expect(byDate("2026-07-12").level).toBe(2)
    expect(byDate("2026-07-08").level).toBe(3)
    expect(byDate("2026-07-07").level).toBe(4)
    expect(byDate("2026-07-14").level).toBe(0)
  })
})
