import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:7420",
      "/ws": { target: "ws://localhost:7420", ws: true },
    },
  },
})
