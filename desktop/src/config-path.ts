import { isAbsolute, join } from "node:path"

export type ConfigFileResolution = { ok: true; configFile: string } | { ok: false; error: string }

/**
 * 决定实际要用的配置文件路径。
 *
 * REPO_RADAR_CONFIG 若设置，必须是绝对路径——不再用 path.resolve() 按 cwd 兜底展开。
 * 上一轮加的 resolve() 是为了让相对路径不至于让 app.setPath("userData", ...) 抛出
 * `Path must be absolute` 而崩溃，但那把「响亮的失败」换成了「静默地按 cwd 选配置文件」：
 * 打包应用启动时的当前工作目录由系统决定、完全不可预期（双击桌面图标、通过任务计划程序/
 * 注册表自启启动等场景下可能是 System32 之类）。用户以为在用 `./work.json`，程序实际用的
 * 是某个他找不到的地方的文件；那个位置大概率也没有配置文件，于是被当成"首次运行"写出一份
 * 全新的默认配置——用户原来的 work.json 分毫未动、原地未变，表面上"没报错"反而是最坏的结果。
 *
 * 因此改为显式拒绝相对路径：报错，不猜。纯函数，不碰 dialog/process——方便测试；
 * 调用方（main.ts）负责在 ok 为 false 时弹 dialog.showErrorBox 并退出。
 */
export function resolveConfigFile(env: string | undefined, home: string): ConfigFileResolution {
  // 缺陷 3：空字符串（`REPO_RADAR_CONFIG=`，在 CI / shell 脚本里很常见，变量声明了但赋的是
  // 空值）在语义上等价于"没设置"，不是"设置成一个空路径"。纯空白同理（复制粘贴/拼接脚本时
  // 手滑带进空格）。上一轮只特判了 undefined，空串/空白会一路走到下面"必须是绝对路径"的
  // 分支，在应用启动的瞬间弹原生错误框并退出——而用户的真实意图往往只是压根没设这个变量。
  if (env === undefined || env.trim() === "") return { ok: true, configFile: join(home, ".repo-radar", "config.json") }
  if (!isAbsolute(env)) {
    return {
      ok: false,
      error: `REPO_RADAR_CONFIG 必须是绝对路径，收到的是:\n"${env}"`,
    }
  }
  return { ok: true, configFile: env }
}
