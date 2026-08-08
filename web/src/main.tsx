import { App as AntApp, ConfigProvider } from "antd"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { I18nProvider, isRtl, type LangCode, readLang } from "./i18n"
import "./index.css"
import { radarTheme, type ThemeMode } from "./theme"

function readMode(): ThemeMode {
  try {
    return localStorage.getItem("rr.theme") === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(readMode)
  const [lang, setLang] = useState<LangCode>(readLang)
  const rtl = isRtl(lang)

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode)
    try {
      localStorage.setItem("rr.theme", mode)
    } catch {
      /* localStorage 不可用时静默 */
    }
  }, [mode])

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
          <App themeMode={mode} onToggleTheme={() => setMode((m) => (m === "dark" ? "light" : "dark"))} />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
