import { readdirSync } from "node:fs"

/**
 * 仅读取仓库根目录（不递归）的标志文件，识别主要语言/技术栈。
 * 同步、永不抛出：任何文件系统错误 → null。
 */
export function detectLanguage(path: string): string | null {
  try {
    const entries = new Set(readdirSync(path))
    const has = (name: string) => entries.has(name)

    if (has("astro.config.mjs") || has("astro.config.ts") || has("astro.config.js")) return "Astro"
    if (has("package.json")) {
      return has("tsconfig.json") ? "TypeScript" : "JavaScript"
    }
    if (has("Cargo.toml")) return "Rust"
    if (has("go.mod")) return "Go"
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) return "Python"
    if ([...entries].some((f) => f.endsWith(".csproj"))) return "C#"
    if (has("pubspec.yaml")) return "Dart"
    if (has("Gemfile")) return "Ruby"
    if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return "Java"
    if (has("composer.json")) return "PHP"

    const files = [...entries]
    if (files.some((f) => f.endsWith(".ps1"))) return "PowerShell"
    if (files.some((f) => f.endsWith(".sh"))) return "Shell"

    return null
  } catch {
    return null
  }
}
