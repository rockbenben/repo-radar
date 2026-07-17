import { useId } from "react"

/** repo-radar 记号：示波镜 + 健康色光点 + 中心青色信号点（与 favicon/og 同一记号）。 */
export function ScopeMark({ size = 24 }: { size?: number }) {
  const uid = useId().replace(/:/g, "")
  const sweep = `sweep-${uid}`
  const glow = `glow-${uid}`
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ display: "block", flex: "none" }}>
      <defs>
        <linearGradient id={sweep} x1="0.5" y1="0.5" x2="1" y2="0">
          <stop offset="0" stopColor="#4cc2ff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#4cc2ff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="#4cc2ff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#4cc2ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M32 32 L32 5 A27 27 0 0 1 58.4 26 Z" fill={`url(#${sweep})`} />
      <g stroke="#3a5f86" fill="none">
        <circle cx="32" cy="32" r="27" strokeWidth="1.6" />
        <circle cx="32" cy="32" r="17.5" strokeWidth="1.2" opacity="0.7" />
        <line x1="32" y1="6" x2="32" y2="58" strokeWidth="1" opacity="0.45" />
        <line x1="6" y1="32" x2="58" y2="32" strokeWidth="1" opacity="0.45" />
      </g>
      <circle cx="46" cy="20" r="2.7" fill="#3ad68a" />
      <circle cx="19.5" cy="27" r="2.7" fill="#f5a623" />
      <circle cx="27" cy="46.5" r="2.7" fill="#ff5a6a" />
      <circle cx="44" cy="45" r="2.2" fill="#3ad68a" />
      <circle cx="32" cy="32" r="7" fill={`url(#${glow})`} />
      <circle cx="32" cy="32" r="2.8" fill="#4cc2ff" />
    </svg>
  )
}
