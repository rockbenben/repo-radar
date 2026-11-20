import { readFileSync } from "node:fs"

const readJson = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))
const { version } = readJson("package.json")
const lock = readJson("package-lock.json")
const lockedRootVersion = lock.packages?.[""]?.version
const tag = process.argv[2]

if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  console.error(`package.json must contain a stable X.Y.Z version, got ${version}`)
  process.exit(1)
}
if (lock.version !== version || lockedRootVersion !== version) {
  console.error(`package-lock.json versions (${lock.version}, ${lockedRootVersion}) must match package.json (${version})`)
  process.exit(1)
}
if (tag !== undefined && tag !== `v${version}`) {
  console.error(`Tag ${tag} does not match package.json version ${version}. Expected v${version}.`)
  process.exit(1)
}

console.log(`Release version verified: v${version}`)
