import { describe, expect, it } from "vitest"
import { buildOpenCommand } from "../src/open"

describe("buildOpenCommand", () => {
  it("substitutes every {path} placeholder", () => {
    expect(buildOpenCommand('code "{path}"', "D:\\repo")).toBe('code "D:\\repo"')
    expect(buildOpenCommand("echo {path} {path}", "x")).toBe("echo x x")
  })
  it("returns template unchanged when no placeholder", () => {
    expect(buildOpenCommand("explorer .", "D:\\repo")).toBe("explorer .")
  })
})
