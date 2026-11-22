import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { renameWithRetry } from "./atomic-write"
import { localDay } from "./local-date"
import type { RepoStatus, WorklogResponse } from "./types"
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

function writeWorklog(file: string, worklog: WorklogResponse): void {
  const snapshot = { format: FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...worklog }
  writeSnapshot(file, `${JSON.stringify(snapshot, null, 2)}\n`)
}

function archiveMonth(root: string, day: string): string {
  return join(root, day.slice(0, 4), day.slice(5, 7))
}

function dateFile(root: string, day: string): string {
  return join(archiveMonth(root, day), `${day}.json`)
}

function readDirectory(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

/** Month directories also record where coverage starts if the first export fails to fill that month. */
function archiveDaysToWrite(root: string, now: Date): string[] {
  const today = localDay(now)
  const initial = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)
  let start = localDay(initial)
  mkdirSync(archiveMonth(root, start), { recursive: true })

  const existing = new Set<string>()
  let latest = ""
  for (const year of readDirectory(root)) {
    if (!year.isDirectory() || !/^[1-9]\d{3}$/.test(year.name)) continue
    const yearPath = join(root, year.name)
    for (const month of readDirectory(yearPath)) {
      if (!month.isDirectory() || !/^(0[1-9]|1[0-2])$/.test(month.name)) continue
      const prefix = `${year.name}-${month.name}`
      const first = `${prefix}-01`
      if (first < start) start = first
      const daysInMonth = new Date(Date.UTC(Number(year.name), Number(month.name), 0)).getUTCDate()
      for (const file of readDirectory(join(yearPath, month.name))) {
        const day = file.name.slice(0, -5)
        if (!file.isFile() || !file.name.endsWith(".json") || !day.startsWith(`${prefix}-`) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) continue
        const dayOfMonth = Number(day.slice(-2))
        if (dayOfMonth < 1 || dayOfMonth > daysInMonth) continue
        existing.add(day)
        if (day > latest) latest = day
      }
    }
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const refreshSince = localDay(yesterday)
  const days: string[] = []
  // Iterate the calendar labels in UTC so DST cannot duplicate or skip a date.
  const date = new Date(`${start}T12:00:00Z`)
  for (let day = start; day <= today; day = date.toISOString().slice(0, 10)) {
    // Refresh the latest historical file too: it may have been written before the app went offline.
    if (day >= refreshSince || day === latest || !existing.has(day)) days.push(day)
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return days
}

async function archiveWorklog(
  root: string,
  days: string[],
  worklog: WorklogResponse,
  isCurrent: () => boolean,
  log: (message: string) => void,
): Promise<void> {
  if (!isCurrent() || days.length === 0) return
  if (worklog.failed.length > 0) {
    log(`[repo-radar] Worklog archive deferred for ${days[0]} through ${days[days.length - 1]}. Incomplete Git results for: ${worklog.failed.join(", ")}`)
    return
  }

  const byDay = new Map<string, WorklogResponse["commits"]>()
  for (const commit of worklog.commits) {
    const commits = byDay.get(commit.day) ?? []
    commits.push(commit)
    byDay.set(commit.day, commits)
  }
  for (const day of days) {
    await setImmediate()
    if (!isCurrent()) return
    try {
      writeWorklog(dateFile(root, day), { ...worklog, since: day, until: day, commits: byDay.get(day) ?? [] })
    } catch (err) {
      log(`[repo-radar] Worklog archive write failed for ${day}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function exportWorklog(
  file: string,
  repos: RepoStatus[],
  isCurrent: () => boolean,
  log: (message: string) => void,
): Promise<void> {
  const now = new Date()
  const firstDay = new Date(now)
  firstDay.setDate(firstDay.getDate() - (WINDOW_DAYS - 1))
  const recent = await queryWorklog(repos, localDay(firstDay), localDay(now))
  if (!isCurrent()) return
  writeWorklog(file, recent)

  const root = join(dirname(file), "archive")
  const days = archiveDaysToWrite(root, now)
  await archiveWorklog(root, days.filter((day) => day >= recent.since), recent, isCurrent, log)
  const older = days.filter((day) => day < recent.since)
  if (older.length === 0 || !isCurrent()) return
  const history = await queryWorklog(repos, older[0], older[older.length - 1])
  await archiveWorklog(root, older, history, isCurrent, log)
}
