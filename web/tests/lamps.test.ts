import { describe, expect, it } from "vitest"
import { visibleLamps } from "../src/lib/lamps"

const ALL = ["no-remote", "detached", "unpushed", "dirty", "behind", "stash"] as const

describe("visibleLamps", () => {
  it("空串（没设置过 / 一盏都没关）：全亮", () => {
    expect(visibleLamps("", ALL)).toEqual([...ALL])
  })

  it("关掉一盏：其余照亮", () => {
    expect(visibleLamps("behind", ALL)).toEqual(["no-remote", "detached", "unpushed", "dirty", "stash"])
  })

  it("全部关掉：一盏都不亮", () => {
    expect(visibleLamps(ALL.join(","), ALL)).toEqual([])
  })

  it("顺序跟随 ALL，不跟随保存值里的先后", () => {
    expect(visibleLamps("dirty,detached", ALL)).toEqual(["no-remote", "unpushed", "behind", "stash"])
  })

  // 存「关掉的」而不是「开着的」，就是为了这条：老用户的偏好里不会有新灯的 key，
  // 于是新灯默认亮着。白名单的话所有升级上来的用户都永远看不到它
  it("以后新增的灯，对已有偏好的用户默认亮着", () => {
    const withNewLamp = [...ALL, "conflict"] as const
    expect(visibleLamps("behind", withNewLamp)).toContain("conflict")
  })
})
