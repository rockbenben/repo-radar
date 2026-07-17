import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { detectLanguage } from "../src/lang"

const dirs: string[] = []
const makeDir = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-lang-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("detectLanguage", () => {
  it("detects TypeScript from package.json + tsconfig.json", () => {
    const d = makeDir()
    writeFileSync(join(d, "package.json"), "{}")
    writeFileSync(join(d, "tsconfig.json"), "{}")
    expect(detectLanguage(d)).toBe("TypeScript")
  })

  it("detects JavaScript from package.json alone", () => {
    const d = makeDir()
    writeFileSync(join(d, "package.json"), "{}")
    expect(detectLanguage(d)).toBe("JavaScript")
  })

  it("detects Astro even when package.json is present", () => {
    const d = makeDir()
    writeFileSync(join(d, "package.json"), "{}")
    writeFileSync(join(d, "astro.config.mjs"), "")
    expect(detectLanguage(d)).toBe("Astro")
  })

  it("detects Rust from Cargo.toml", () => {
    const d = makeDir()
    writeFileSync(join(d, "Cargo.toml"), "")
    expect(detectLanguage(d)).toBe("Rust")
  })

  it("detects Go from go.mod", () => {
    const d = makeDir()
    writeFileSync(join(d, "go.mod"), "")
    expect(detectLanguage(d)).toBe("Go")
  })

  it("detects Python from requirements.txt", () => {
    const d = makeDir()
    writeFileSync(join(d, "requirements.txt"), "")
    expect(detectLanguage(d)).toBe("Python")
  })

  it("detects PowerShell from a lone .ps1 file", () => {
    const d = makeDir()
    writeFileSync(join(d, "foo.ps1"), "")
    expect(detectLanguage(d)).toBe("PowerShell")
  })

  it("returns null for an empty dir", () => {
    const d = makeDir()
    expect(detectLanguage(d)).toBeNull()
  })

  it("returns null (never throws) for a nonexistent path", () => {
    expect(detectLanguage(join(tmpdir(), "rr-lang-does-not-exist-xyz"))).toBeNull()
  })
})
