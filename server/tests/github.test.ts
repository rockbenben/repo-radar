import { describe, expect, it } from "vitest"
import { githubSlug } from "../src/github"

describe("githubSlug", () => {
  it("parses https urls with and without .git", () => {
    expect(githubSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
    expect(githubSlug("https://github.com/owner/repo")).toBe("owner/repo")
    expect(githubSlug("https://github.com/owner/repo/")).toBe("owner/repo")
  })
  it("parses ssh urls", () => {
    expect(githubSlug("git@github.com:owner/repo.git")).toBe("owner/repo")
    expect(githubSlug("git@github.com:owner/repo")).toBe("owner/repo")
  })
  it("returns null for non-github urls", () => {
    expect(githubSlug("https://gitlab.com/owner/repo.git")).toBeNull()
    expect(githubSlug("https://example.com/x")).toBeNull()
  })
})
