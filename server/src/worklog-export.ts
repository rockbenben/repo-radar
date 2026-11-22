import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { renameWithRetry } from "./atomic-write"
import { localDay } from "./local-date"
import type { RepoStatus } from "./types"
import { queryWorklog } from "./worklog"

const FORMAT = "repo-radar-worklog"
const SCHEMA_VERSION = 1
const WINDOW_DAYS = 30

function writeSnapshot(file: string, contents: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.repo-radar-worklog-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })
    const existing = lstatSync(file, { throwIfNoEntry: false })
    if (existing) {
      let format: unknown
      if (existing.isFile()) {
        try {
          format = JSON.parse(readFileSync(file, "utf8"))?.format
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err
        }
      }
      if (format !== FORMAT) throw new Error(`Destination already exists and is not a Repo Radar worklog: ${file}`)
    }
    renameWithRetry(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export async function exportWorklog(file: string, repos: RepoStatus[], isCurrent: () => boolean): Promise<void> {
  const now = new Date()
  const firstDay = new Date(now)
  firstDay.setDate(firstDay.getDate() - (WINDOW_DAYS - 1))
  const worklog = await queryWorklog(repos, localDay(firstDay), localDay(now))
  if (!isCurrent()) return
  const snapshot = { format: FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...worklog }
  writeSnapshot(file, `${JSON.stringify(snapshot, null, 2)}\n`)
}
