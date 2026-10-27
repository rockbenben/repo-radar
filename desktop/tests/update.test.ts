import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkForUpdates } from "../src/update"

// desktop 单测不加载真 electron（多个文件并行 import 会抢着解压二进制，Windows CI 上 os error 183）。
// 更新器只在这里被 mock 成可控的 check/download/install 三步。
const mocks = vi.hoisted(() => {
  const responses: number[] = []
  return {
    isPackaged: true,
    locale: "en",
    responses,
    showMessageBox: vi.fn(async (...args: unknown[]) => {
      const options = (args.length === 2 ? args[1] : args[0]) as { cancelId?: number }
      return { response: responses.length > 0 ? responses.shift()! : (options.cancelId ?? 1) }
    }),
    autoUpdater: {
      on: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(async () => {}),
      quitAndInstall: vi.fn(),
      autoDownload: true,
      autoInstallOnAppQuit: true,
    },
  }
})

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged
    },
    getLocale: () => mocks.locale,
  },
  dialog: { showMessageBox: mocks.showMessageBox },
}))

vi.mock("electron-updater", () => ({ autoUpdater: mocks.autoUpdater }))

const host = { getWindow: () => null }
const available = { isUpdateAvailable: true, updateInfo: { version: "9.9.9" } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isPackaged = true
  mocks.locale = "en"
  mocks.responses.length = 0
  mocks.autoUpdater.autoDownload = true
  mocks.autoUpdater.autoInstallOnAppQuit = true
  mocks.autoUpdater.checkForUpdates.mockReset()
  mocks.autoUpdater.downloadUpdate.mockReset().mockResolvedValue(undefined)
  mocks.autoUpdater.quitAndInstall.mockReset()
})

describe("checkForUpdates — 默认关闭与静默边界", () => {
  it("开发运行返回 skipped，手动点才弹说明", async () => {
    mocks.isPackaged = false
    await expect(checkForUpdates(host, true)).resolves.toBe("skipped")
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it("自动检查在已是最新时完全沉默；手动检查必须有回执", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false })
    await expect(checkForUpdates(host, false)).resolves.toBe("upToDate")
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    await expect(checkForUpdates(host, true)).resolves.toBe("upToDate")
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
  })

  it("检查失败：自动静默，手动弹失败说明", async () => {
    mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error("offline"))
    await expect(checkForUpdates(host, false)).resolves.toBe("failed")
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    await expect(checkForUpdates(host, true)).resolves.toBe("failed")
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
  })

  it("手动检查使用 web 传来的界面语言", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false })
    await expect(checkForUpdates(host, true, "zh-Hans")).resolves.toBe("upToDate")
    const options = mocks.showMessageBox.mock.calls.at(-1)?.[0] as { message?: string }
    expect(options.message).toBe("已是最新版本")
  })
})

describe("checkForUpdates — 两个默认值必须被关掉", () => {
  it("发现新版但用户点「稍后」：不下载、不安装，auto 两开关都为 false", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(available)
    mocks.responses.push(1)
    await expect(checkForUpdates(host, true)).resolves.toBe("available")
    expect(mocks.autoUpdater.autoDownload).toBe(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("下载完成但用户不安装：quitAndInstall 不得被调用", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(available)
    mocks.responses.push(0, 1)
    await expect(checkForUpdates(host, true)).resolves.toBe("downloaded")
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("用户确认安装才 quitAndInstall", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(available)
    mocks.responses.push(0, 0)
    await expect(checkForUpdates(host, true)).resolves.toBe("downloaded")
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it("下载失败时把发布页作为手动退路告诉用户", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(available)
    mocks.autoUpdater.downloadUpdate.mockRejectedValue(new Error("404"))
    mocks.responses.push(0)
    await expect(checkForUpdates(host, true)).resolves.toBe("failed")
    const last = mocks.showMessageBox.mock.calls.at(-1)?.[0] as { detail?: string }
    expect(last.detail).toContain("github.com/rockbenben/repo-radar/releases/latest")
  })
})

describe("checkForUpdates — 并发与异常边界", () => {
  it("并发调用共享同一次检查，不叠出两套对话框", async () => {
    let resolveCheck!: (value: unknown) => void
    mocks.autoUpdater.checkForUpdates.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
    )
    const first = checkForUpdates(host, false)
    const second = checkForUpdates(host, false)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    resolveCheck({ isUpdateAvailable: false })
    await expect(first).resolves.toBe("upToDate")
    await expect(second).resolves.toBe("upToDate")
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })

  it("手动检查加入自动检查时仍拿到回执", async () => {
    let resolveCheck!: (value: unknown) => void
    mocks.autoUpdater.checkForUpdates.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
    )
    const auto = checkForUpdates(host, false)
    const manual = checkForUpdates(host, true, "zh-Hans")
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    resolveCheck({ isUpdateAvailable: false })
    await expect(auto).resolves.toBe("upToDate")
    await expect(manual).resolves.toBe("upToDate")
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    const options = mocks.showMessageBox.mock.calls.at(-1)?.[0] as { message?: string }
    expect(options.message).toBe("已是最新版本")
  })

  it("对话框 reject 不冒泡成未捕获异常，按取消处理", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false })
    mocks.showMessageBox.mockRejectedValueOnce(new Error("window destroyed"))
    await expect(checkForUpdates(host, true)).resolves.toBe("upToDate")
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
