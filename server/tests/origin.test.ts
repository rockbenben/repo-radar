import { describe, expect, it } from "vitest"
import { DEFAULT_PORT } from "../src/port"
import { originAllowed } from "../src/routes"

// 同源白名单必须按**实际绑定的**端口算。端口回退（原端口被系统保留/被占用时换一个）之后
// 白名单还停在原端口的话，界面自己发的请求就成了「跨站」，整个 API 当场 403——
// 一个「窗口开着、按钮全都点不动」的失败，比起不来更难查
describe("originAllowed", () => {
  it("无 Origin 头放行（curl、同源导航）", () => {
    expect(originAllowed(undefined, 17420)).toBe(true)
  })

  it("放行传入端口上的 localhost / 127.0.0.1", () => {
    expect(originAllowed("http://localhost:8420", 8420)).toBe(true)
    expect(originAllowed("http://127.0.0.1:8420", 8420)).toBe(true)
  })

  it("拒绝别的端口——包括默认端口（回退后默认端口上跑的可能是别人）", () => {
    expect(originAllowed(`http://127.0.0.1:${DEFAULT_PORT}`, 8420)).toBe(false)
    expect(originAllowed("http://127.0.0.1:9999", 8420)).toBe(false)
  })

  // 5173 是 vite 的默认端口——用户机器上任何别的前端项目、或一个恶意页面都可能跑在那上面。
  // 而 Origin 校验是本服务对 API 的唯一跨站防线（全程不发 CORS 头），破坏性端点又都是
  // 无需预检的简单请求（POST 无自定义头）。放行只能是开发模式下的显式选择，绝不能编进发行版
  it("vite dev server 仅在显式开启时放行", () => {
    expect(originAllowed("http://localhost:5173", 8420, true)).toBe(true)
    expect(originAllowed("http://127.0.0.1:5173", 8420, true)).toBe(true)
  })

  it("默认不放行 5173：漏传参数的后果是开发不便，而不是给发行版开洞", () => {
    expect(originAllowed("http://localhost:5173", 8420)).toBe(false)
    expect(originAllowed("http://127.0.0.1:5173", 8420, false)).toBe(false)
  })

  it("开发模式也只额外放行 5173，不是放行一切", () => {
    expect(originAllowed("https://evil.example", 8420, true)).toBe(false)
    expect(originAllowed("http://localhost:5174", 8420, true)).toBe(false)
  })

  it("跨站来源一律拒绝", () => {
    expect(originAllowed("https://evil.example", 8420)).toBe(false)
    expect(originAllowed("http://localhost.evil.example:8420", 8420)).toBe(false)
  })

  it("省略端口参数时退回默认端口，老调用点行为不变", () => {
    expect(originAllowed(`http://127.0.0.1:${DEFAULT_PORT}`)).toBe(true)
  })
})
