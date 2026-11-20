import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { parse } from "yaml"

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")
const rootRequire = createRequire(new URL("../package.json", import.meta.url))
const desktopRequire = createRequire(new URL("../desktop/package.json", import.meta.url))
const targets = JSON.parse(read("../.github/desktop-version-targets.json")).npm

for (const name of ["electron", "electron-builder", "electron-updater"]) {
  const resolveFrom = name === "electron" ? desktopRequire : rootRequire
  const { version } = resolveFrom(`${name}/package.json`)
  if (!/^\d+\.\d+\.\d+$/.test(version) || Number(version.split(".")[0]) !== targets[name]) {
    throw new Error(`${name}: expected stable ${targets[name]}.x, installed ${version}`)
  }
  console.log(`${name} ${version}`)
}

const { nsis } = parse(read("../electron-builder.yml"), { maxAliasCount: 0 })
if (JSON.stringify(nsis?.installerLanguages) !== '["en_US"]' || nsis?.displayLanguageSelector !== false) {
  throw new Error("NSIS must use only en_US and disable the language selector")
}
console.log("NSIS installer language verified")
