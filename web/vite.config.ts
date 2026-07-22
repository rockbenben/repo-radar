import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 开发代理跟随 REPO_RADAR_PORT：`npm run dev` 会把它同时传给 server 和 vite，
// 端口改了而这里写死的话，dev 下整个 /api 静默 502
const port = process.env.REPO_RADAR_PORT || "7420"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${port}`,
      "/ws": { target: `ws://localhost:${port}`, ws: true },
    },
  },
})
