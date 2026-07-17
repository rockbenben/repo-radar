import { defineConfig } from "vitest/config"

// 服务端测试大量走真实 git（clone/commit/fetch），并行满载时默认 5s 超时会偶发抖动。
// 放宽单测与钩子超时；真实用例通常 0.5–2s，30s 只是给满载时留足冗余。
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
