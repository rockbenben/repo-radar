import { type ThemeConfig, theme } from "antd"

// 方向 01「仪表舱」——把仪表舱配色映射到 antd 6 的 CSS variables 主题。
// antd 组件只做交互与可达性底座；视觉层这里定 token，卡片等签名元素再用 CSS 变量深度定制。
//
// ⚠ 这两份调色板与 index.css 顶部的 :root / :root[data-theme="light"] 是**同一套颜色的两份声明**，
// 必须手动保持一致。它们服务不同的消费方：CSS 变量给我们自己的签名类，这里的常量给 antd
// 生成组件色（colorPrimary/colorLink…）。曾经只改了 CSS 一侧，结果卡片上的分支名用了新色、
// 仓库链接还是旧色——同一张卡两个蓝，正是这份重复造成的。改任何一个色，两处都要改。
const INSTRUMENT = {
  ink: "#0b0e15",
  panel: "#111726",
  panel2: "#0d1220",
  card: "#0f1626",
  line: "#1e2838",
  line2: "#161f2f",
  text: "#c8d1e0",
  hi: "#e6edf7",
  dim: "#7b89a6",
  dim2: "#43506a",
  ok: "#3ad68a",
  warn: "#f5a623",
  crit: "#ff5a6a",
  sig: "#4cc2ff",
} as const

// 浅色「日照舱」——同一套仪表语汇，换成明亮的舱内照明：底白、深墨字，
// 强调色加深提饱和以在白底上保持对比（深色版的亮绿/亮蓝在白底会发虚）。
const INSTRUMENT_LIGHT = {
  ink: "#eceff4",
  panel: "#ffffff",
  panel2: "#f4f6fa",
  card: "#ffffff",
  line: "#d9dfe8",
  line2: "#e6eaf0",
  text: "#3b4657",
  hi: "#141a24",
  dim: "#5f6a7e",
  dim2: "#aab3c2",
  ok: "#0b7a4d",
  warn: "#8a5a06",
  crit: "#c9293a",
  sig: "#12699e",
} as const

export type ThemeMode = "dark" | "light"

const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

export function radarTheme(mode: ThemeMode): ThemeConfig {
  const p = mode === "dark" ? INSTRUMENT : INSTRUMENT_LIGHT
  return {
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    cssVar: { key: "radar" },
    token: {
      colorPrimary: p.sig,
      colorInfo: p.sig,
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.crit,
      colorBgBase: p.ink,
      colorTextBase: p.text,
      colorBorder: p.line,
      colorBorderSecondary: p.line2,
      borderRadius: 10,
      fontFamily: SANS,
      fontSize: 13,
      wireframe: false,
    },
    components: {
      Card: { colorBgContainer: p.card, colorBorderSecondary: p.line },
      // 弹窗贴合仪表舱：内容/头部用面板底色（而非 antd 默认的中性深灰浮层），标题高亮，遮罩偏冷调
      Modal: { contentBg: p.panel, headerBg: p.panel, titleColor: p.hi, titleFontSize: 14 },
      Drawer: { colorBgElevated: p.panel2 },
      Input: { colorBgContainer: p.panel2, colorBorder: p.line },
      Select: { colorBgContainer: p.panel2, colorBorder: p.line },
      Segmented: { colorBgLayout: p.panel2, itemSelectedBg: p.panel },
      Button: {
        defaultBg: mode === "dark" ? "#152033" : "#eef2f8",
        defaultBorderColor: p.line,
        defaultColor: p.text,
      },
      Tooltip: { colorBgSpotlight: p.panel },
    },
  }
}
