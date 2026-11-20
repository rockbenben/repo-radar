/// <reference types="vite/client" />

interface Window {
  repoRadarWindow?: { setTheme(mode: "dark" | "light"): void }
}

interface Navigator {
  windowControlsOverlay?: EventTarget & { readonly visible: boolean }
}
