import { createHash } from "node:crypto"
import { createReadStream, lstatSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "yaml"

async function checkUpdateMetadata(directory, version, name, installer, size) {
  const data = parse(await readFile(join(directory, name), "utf8"), { maxAliasCount: 0 })
  if (data?.version !== version) throw new Error(`${name}: expected version ${version}`)
  if (
    !Array.isArray(data.files) || data.files.length !== 1 || data.files[0]?.url !== installer ||
    (data.path !== undefined && data.path !== installer)
  ) {
    throw new Error(`${name}: expected installer ${installer}`)
  }
  const [file] = data.files
  if (file.size !== undefined && file.size !== size) throw new Error(`${name}: incorrect file size for ${installer}`)
  const hash = createHash("sha512")
  for await (const chunk of createReadStream(join(directory, installer))) hash.update(chunk)
  const sha512 = hash.digest("base64")
  if (file.sha512 !== sha512 || (data.sha512 !== undefined && data.sha512 !== sha512)) {
    throw new Error(`${name}: SHA-512 mismatch for ${installer}`)
  }
}

export async function checkReleaseAssets(directory, version, lane) {
  const prefix = `repo-radar-${version}`
  const win = `${prefix}-x64-setup.exe`
  const linuxX64 = `${prefix}-x86_64.AppImage`
  const linuxArm = `${prefix}-arm64.AppImage`
  const lanes = new Map([
    ["win", { installers: [win], extras: [`${win}.blockmap`], update: "latest.yml" }],
    ["mac", { installers: [`${prefix}-x64.dmg`, `${prefix}-arm64.dmg`], extras: [] }],
    ["linux-x64", { installers: [linuxX64], extras: [], update: "latest-linux.yml" }],
    ["linux-arm64", { installers: [linuxArm], extras: [], update: "latest-linux-arm64.yml" }],
  ])
  const selected = lane === undefined ? [...lanes.values()] : [lanes.get(lane)]
  for (const assets of selected) {
    if (!assets) throw new Error(`Unknown release build: ${lane}`)
    const { installers, extras, update } = assets
    const files = [...installers, ...extras]
    if (update) files.push(update)
    const sizes = new Map()
    for (const name of files) {
      const stat = lstatSync(join(directory, name), { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing or empty release asset: ${name}`)
      sizes.set(name, stat.size)
    }
    if (update) await checkUpdateMetadata(directory, version, update, installers[0], sizes.get(installers[0]))
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [directory, lane] = process.argv.slice(2)
    if (!directory) throw new Error("Usage: node scripts/check-release-assets.mjs <directory> [build]")
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    await checkReleaseAssets(directory, version, lane)
    console.log(`Release assets verified for ${version}${lane ? ` (${lane})` : ""}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
