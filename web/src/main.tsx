import { App as AntApp, ConfigProvider } from "antd"
import { useEffect, useLayoutEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { I18nProvider, isRtl, type LangCode, readLang } from "./i18n"
import "./index.css"
import { radarTheme, type ThemePreference } from "./theme"

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")

function readThemePreference(): ThemePreference {
  try {
    const preference = localStorage.getItem("rr.theme")
    if (preference === "light" || preference === "dark") return preference
  } catch {
    /* localStorage 不可用时跟随系统 */
  }
  return "system"
}

function Root() {
  const [preference, setPreference] = useState(readThemePreference)
  const [systemDark, setSystemDark] = useState(() => systemTheme.matches)
  const mode = preference === "system" ? (systemDark ? "dark" : "light") : preference
  const [lang, setLang] = useState<LangCode>(readLang)
  const rtl = isRtl(lang)

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", mode)
    window.repoRadarWindow?.setTheme(mode)
  }, [mode])

  useEffect(() => {
    const sync = () => setSystemDark(systemTheme.matches)
    systemTheme.addEventListener("change", sync)
    sync()
    return () => systemTheme.removeEventListener("change", sync)
  }, [])

  useEffect(() => {
    try {
      if (preference === "system") localStorage.removeItem("rr.theme")
      else localStorage.setItem("rr.theme", preference)
    } catch {
      /* localStorage 不可用时静默 */
    }
  }, [preference])

  useEffect(() => {
    if (!window.repoRadarWindow) return
    const overlay = navigator.windowControlsOverlay
    if (!overlay) return
    const syncOverlay = () => document.documentElement.toggleAttribute("data-window-controls-overlay", overlay.visible)
    syncOverlay()
    overlay.addEventListener("geometrychange", syncOverlay)
    return () => overlay.removeEventListener("geometrychange", syncOverlay)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = rtl ? "rtl" : "ltr"
    try {
      localStorage.setItem("rr.lang", lang)
    } catch {
      /* 静默 */
    }
  }, [lang, rtl])

  // direction 传给 antd ConfigProvider，让 Select/Modal/Dropdown/Segmented 等内部布局也镜像
  return (
    // button.autoInsertSpace：antd 默认给「恰好两个汉字」的按钮塞一个空格，于是「退出」渲染成
    // 「退 出」、「添加」成「添 加」，看着像排版事故。这个产品 18 种语言里有 4 种是 CJK，
    // 按钮文案又短，撞上的概率很高——全局关掉，一处生效
    <ConfigProvider theme={radarTheme(mode)} direction={rtl ? "rtl" : "ltr"} button={{ autoInsertSpace: false }}>
      <I18nProvider lang={lang} setLang={setLang}>
        <AntApp>
          <App themePreference={preference} onThemeChange={setPreference} />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
