import { describe, expect, it } from "vitest"
import { parseOpenCommand } from "../src/open"

describe("parseOpenCommand", () => {
  it("passes the path literally as an argument even if it contains shell syntax", () => {
    const path = "D:\\repo folder\\$ & name"
    expect(parseOpenCommand('"C:\\Program Files\\Editor\\editor.exe" --dir="{path}" "{path}"', path)).toEqual({
      file: "C:\\Program Files\\Editor\\editor.exe",
      args: [`--dir=${path}`, path],
    })
  })

  it("keeps the arguments of a command without a placeholder", () => {
    expect(parseOpenCommand("explorer .", "D:\\repo")).toEqual({ file: "explorer", args: ["."] })
  })

  it("rejects unquoted shell operators and an unclosed quote", () => {
    expect(() => parseOpenCommand("editor | printer", "/repo")).toThrow()
    expect(() => parseOpenCommand('editor "unclosed', "/repo")).toThrow()
  })
})
