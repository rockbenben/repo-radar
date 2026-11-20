import { contextBridge, ipcRenderer } from "electron"
import { TITLE_BAR_THEME } from "./titlebar"

contextBridge.exposeInMainWorld("repoRadarWindow", {
  setTheme: (mode: "dark" | "light") => ipcRenderer.send(TITLE_BAR_THEME, mode),
})
