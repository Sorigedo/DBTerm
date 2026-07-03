// 环境背景水印：生产/预发/只读时在容器内平铺淡色对角文字，提醒当前环境。
// 用 SVG 平铺（小字、多个），pointer-events:none 不挡操作。父容器需 position: relative。
import { useSettingsStore } from '../../stores/settingsStore'
import { THEMES } from '../../themes'

interface Props {
  envLabel?: string | null
  readonly?: boolean | null
}

export default function EnvWatermark({ envLabel, readonly }: Props) {
  const theme = useSettingsStore(s => s.resolvedTheme)
  const isDark = (THEMES[theme]?.mode ?? 'dark') === 'dark'

  const SEV = {
    prod:     { text: '生产环境', color: isDark ? '#9898b4' : '#dc2626', op: isDark ? 0.12 : 0.085, strip: isDark ? 'var(--accent)' : '#dc2626' },
    staging:  { text: '预发环境', color: isDark ? '#9898b4' : '#ea580c', op: isDark ? 0.10 : 0.07,  strip: isDark ? 'var(--accent)' : '#ea580c' },
    readonly: { text: '只读',     color: isDark ? '#9898b4' : '#64748b', op: isDark ? 0.09 : 0.05,  strip: isDark ? 'var(--border)'  : '#94a3b8' },
  } as const

  const sev: keyof typeof SEV | null =
    envLabel === 'prod' ? 'prod'
    : envLabel === 'staging' ? 'staging'
    : readonly ? 'readonly' : null
  if (!sev) return null
  const { text, color, op, strip } = SEV[sev]
  // 直接平铺 <text> 元素，避免 fill="url(#id)" 在打包版 Tauri（WebView2/WKWebView）
  // 中因自定义 URL scheme 导致 fragment 引用失败的问题。
  const COLS = 14  // 覆盖到 4K 宽度（每格 300px）
  const ROWS = 12  // 覆盖到 4K 高度（每格 190px）
  return (
    <>
      <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: strip, zIndex: 6, pointerEvents: 'none' }} />
      <svg aria-hidden="true" overflow="hidden" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', zIndex: 4, pointerEvents: 'none' }}>
        {Array.from({ length: ROWS }, (_, row) =>
          Array.from({ length: COLS }, (_, col) => {
            const cx = col * 300 + 150
            const cy = row * 190 + 105
            return (
              <text key={`${row}-${col}`}
                x={cx} y={cy}
                fontFamily="-apple-system,BlinkMacSystemFont,sans-serif"
                fontSize="17" fontWeight="600" letterSpacing="3"
                fill={color} fillOpacity={op}
                textAnchor="middle" transform={`rotate(-24 ${cx} ${cy})`}
              >{text}</text>
            )
          })
        )}
      </svg>
    </>
  )
}
