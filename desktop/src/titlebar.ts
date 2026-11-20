export const TITLE_BAR_THEME = "repo-radar:title-bar-theme"

export function titleBarOverlay(mode: "dark" | "light") {
  // 与标题栏的 --panel、--text 一致。
  const colors = mode === "light"
    ? { color: "#ffffff", symbolColor: "#3b4657" }
    : { color: "#111726", symbolColor: "#c8d1e0" }
  return { ...colors, height: 32 }
}
