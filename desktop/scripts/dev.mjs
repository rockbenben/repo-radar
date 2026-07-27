// npm run dev（根）用它拉起未打包的 electron，并显式设置 REPO_RADAR_DEV=1——
// main.ts 靠这个环境变量区分「npm run dev（要连 vite 的 5173 热更新）」与
// 「npm start（要连后端自己的端口，不指望 vite 在跑）」。
// 之所以不直接在 package.json 的 dev 脚本里写 `REPO_RADAR_DEV=1 electron .`：
// 这种写法在 Windows 的 cmd.exe 下不生效（cmd 不认 `VAR=1 cmd` 这种前缀语法，
// 只有 POSIX shell 认），改成这个小脚本在 Node 里设置 env 后再 spawn electron，天然跨平台。
import { spawnSync } from "node:child_process"
import electronPath from "electron"

const result = spawnSync(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, REPO_RADAR_DEV: "1" },
})
process.exit(result.status ?? 1)
