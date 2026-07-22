import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, resolve, sep } from "node:path"
import type { MiddlewareHandler } from "hono"

/**
 * 从磁盘服务前端资源。**只接受绝对 root**——原先用的 serveStatic 以进程 cwd 解析相对路径，
 * 打包成桌面应用后 cwd 由系统决定，那种写法必然静默失效（页面全 404，看着像后端没起来）。
 */

// vite 构建产物里带内容哈希的文件名形如 assets/index-Bnq-Lu8S.js：哈希变了文件名就变，
// 才能安全地长缓存（immutable）。web/public/ 下的静态资源（favicon.svg、logo.svg、
// og-image.png）会原样落到 dist 根部、文件名不带哈希，若同样给一年 immutable，
// 内容更新后浏览器会拿着旧文件錮死一年——因此长缓存只给「位于 assets/ 下、文件名带哈希」的文件，
// 其余（包括 index.html）一律 no-cache，每次都向服务器校验。
// rel 取自 URL path（见下面 decodedPath），恒为正斜杠，不随操作系统变化，故只匹配 "/"
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/.]+$/

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

export function diskStatic(root: string): MiddlewareHandler {
  const base = resolve(root)
  return async (c, next) => {
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(c.req.path)
    } catch {
      // 畸形百分号编码（如 "/%"）会让 decodeURIComponent 抛 URIError；
      // 中间件的前提是"未命中就 next()"，畸形请求不该穿出去变成裸 500，交给后面的路由兜底
      return next()
    }
    const rel = c.req.path === "/" ? "index.html" : decodedPath.slice(1)
    const file = resolve(base, rel)
    // 路径穿越防护：不能用 relative() 的字符串前缀判断（如 startsWith("..")）。
    // 当 rel 本身是绝对路径（如 "C:/Windows/win.ini"）时，resolve(base, rel) 会直接丢弃
    // base、返回该绝对路径；而 Node 的 path.relative 在 Windows 上遇到跨盘符时，返回的是
    // 目标的绝对路径本身、不带 ".." 前缀，导致穿越检测失效。这里改为直接比较解析后的绝对
    // 路径是否等于 base 或以 "base + 分隔符" 开头——对跨盘符、UNC 路径、任意绝对路径注入
    // 都成立，不依赖 relative() 的字符串形状。
    if (file !== base && !file.startsWith(base + sep)) return next()
    if (!existsSync(file) || !statSync(file).isFile()) return next() // 非静态资源：交给后面的路由，最终落 404

    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream"
    // 只有 assets/ 下带内容哈希的构建产物才长缓存；index.html 与 public/ 下原样落地、
    // 文件名不带哈希的资源（favicon.svg、logo.svg、og-image.png 等）一律 no-cache，
    // 否则升级后浏览器仍会用一年前钉住的旧文件
    const cacheControl = HASHED_ASSET.test(rel) ? "public, max-age=31536000, immutable" : "no-cache"
    return c.body(new Uint8Array(readFileSync(file)), 200, { "content-type": type, "cache-control": cacheControl })
  }
}
