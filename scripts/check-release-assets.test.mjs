import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parse } from "yaml"
import { checkReleaseAssets } from "./check-release-assets.mjs"

test("release is triggered by a manual stable tag and publishes the verified draft", async () => {
  const workflow = async (name) => parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"))
  const release = await workflow("release")
  const ci = await workflow("ci")
  assert.deepEqual(release.on, { push: { tags: ["v*"] }, workflow_dispatch: null })
  assert.equal(ci.jobs.release, undefined)

  const { validate, build, publish } = release.jobs
  assert.equal(validate.steps[0].if, "github.ref_type != 'tag'")
  assert.equal(build.needs, "validate")
  assert.deepEqual(publish.needs, ["validate", "build"])
  const apply = build.steps.findIndex((step) => step.run?.endsWith("release-version.mjs apply electron"))
  const install = build.steps.findIndex((step) => step.run === "npm ci")
  assert.ok(apply >= 0 && apply < install)
  const stage = publish.steps.findIndex((step) => step.id === "stage")
  assert.equal(publish.steps[stage].with.draft, true)
  assert.match(publish.steps[stage - 1].run, /release-state\.mjs guard$/)
  assert.match(publish.steps[stage + 1].run, /release-state\.mjs publish out$/)
})

const version = "1.2.3"
const prefix = `repo-radar-${version}`
const win = `${prefix}-x64-setup.exe`
const linuxX64 = `${prefix}-x86_64.AppImage`
const linuxArm = `${prefix}-arm64.AppImage`

function metadata(asset, { release = version, url = asset } = {}) {
  const sha512 = createHash("sha512").update(asset).digest("base64")
  return `version: ${release}
files:
  - url: ${url}
    sha512: ${sha512}
    size: ${Buffer.byteLength(asset)}
path: ${url}
sha512: ${sha512}
`
}

async function fixture(context) {
  const dir = await mkdtemp(join(tmpdir(), "rr-release-test-"))
  context.after(async () => {
    const files = await readdir(dir)
    await Promise.all(files.map((name) => unlink(join(dir, name))))
    await rmdir(dir)
  })
  const files = {
    [win]: win,
    [`${win}.blockmap`]: "blockmap",
    [`${prefix}-x64.dmg`]: "dmg x64",
    [`${prefix}-arm64.dmg`]: "dmg arm64",
    [linuxX64]: linuxX64,
    [linuxArm]: linuxArm,
    "latest.yml": metadata(win),
    "latest-linux.yml": metadata(linuxX64),
    "latest-linux-arm64.yml": metadata(linuxArm),
  }
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(dir, name), value)))
  return dir
}

test("accepts the complete stable release, including both macOS DMGs without requiring a ZIP", async (t) => {
  const dir = await fixture(t)
  await checkReleaseAssets(dir, version)
  await checkReleaseAssets(dir, version, "mac")
})

for (const missing of [`${prefix}-arm64.dmg`, linuxArm, `${win}.blockmap`, "latest-linux-arm64.yml"]) {
  test(`rejects a release missing ${missing}`, async (t) => {
    const dir = await fixture(t)
    await unlink(join(dir, missing))
    await assert.rejects(checkReleaseAssets(dir, version), { message: `Missing or empty release asset: ${missing}` })
  })
}

test("rejects metadata from the wrong version or architecture", async (t) => {
  const dir = await fixture(t)
  const file = join(dir, "latest-linux-arm64.yml")
  await writeFile(file, metadata(linuxArm, { release: "1.2.2" }))
  await assert.rejects(checkReleaseAssets(dir, version), /latest-linux-arm64\.yml.*version/)
  await writeFile(file, metadata(linuxArm, { url: linuxX64 }))
  await assert.rejects(checkReleaseAssets(dir, version), /latest-linux-arm64\.yml.*arm64\.AppImage/)
})

test("rejects metadata when the downloaded installer differs from its checksum", async (t) => {
  const dir = await fixture(t)
  await writeFile(join(dir, win), "x".repeat(win.length))
  await assert.rejects(checkReleaseAssets(dir, version), /latest\.yml.*SHA-512/)
})

test("rejects stray files in the final release directory", async (t) => {
  const dir = await fixture(t)
  await writeFile(join(dir, "latest-mac.yml"), metadata(`${prefix}-x64.dmg`))
  await assert.rejects(checkReleaseAssets(dir, version), /Unexpected release asset: latest-mac\.yml/)
})
