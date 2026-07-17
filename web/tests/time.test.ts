import { describe, expect, it } from "vitest"
import { relativeTime } from "../src/lib/time"

const NOW = new Date("2026-07-14T12:00:00Z").getTime()

describe("relativeTime", () => {
  it("formats days ago", () => {
    expect(relativeTime("2026-07-11T12:00:00Z", NOW)).toBe("3天前")
  })
  it("formats months ago", () => {
    expect(relativeTime("2026-05-01T12:00:00Z", NOW)).toBe("2个月前")
  })
  it("formats just now", () => {
    expect(relativeTime("2026-07-14T11:59:40Z", NOW)).toBe("刚刚")
  })
})
