type P = { size?: number }

export function IcoTiDB({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="18" height="4" rx="1.5"/>
      <rect x="10" y="7" width="4" height="14" rx="1.5"/>
    </svg>
  )
}

export function IcoOceanBase({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 9Q7.5 4 12 9Q16.5 14 21 9"
            stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"/>
      <path d="M3 15Q7.5 10 12 15Q16.5 20 21 15"
            stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" opacity="0.5"/>
    </svg>
  )
}

export function IcoKingBase({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 16l2.5-8 5.5 5 5.5-5L20 16H4z"/>
      <rect x="4" y="17" width="16" height="3" rx="1.2"/>
    </svg>
  )
}

export function IcoOpenGauss({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M2 19Q5 4 12 4Q19 4 22 19"
            stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"/>
      <line x1="12" y1="6" x2="12" y2="18"
            stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.5 2" opacity="0.5"/>
      <line x1="3" y1="19" x2="21" y2="19"
            stroke="currentColor" strokeWidth="1.4" opacity="0.35"/>
    </svg>
  )
}

export function IcoSqlServer({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6C4 4.895 7.582 4 12 4C16.418 4 20 4.895 20 6V9C20 10.105 16.418 11 12 11C7.582 11 4 10.105 4 9V6Z" opacity="0.9"/>
      <path d="M4 9V12C4 13.105 7.582 14 12 14C16.418 14 20 13.105 20 12V9C20 10.105 16.418 11 12 11C7.582 11 4 10.105 4 9Z" opacity="0.65"/>
      <path d="M4 12V15C4 16.105 7.582 17 12 17C16.418 17 20 16.105 20 15V12C20 13.105 16.418 14 12 14C7.582 14 4 13.105 4 12Z" opacity="0.4"/>
      <path d="M4 15V18C4 19.105 7.582 20 12 20C16.418 20 20 19.105 20 18V15C20 16.105 16.418 17 12 17C7.582 17 4 16.105 4 15Z" opacity="0.25"/>
    </svg>
  )
}

export function IcoDuckDB({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <ellipse cx="11" cy="13" rx="8" ry="6.5"/>
      <circle cx="15" cy="10" r="1.8" fill="#000" opacity="0.55"/>
      <path d="M17 12 Q21 10 20 14.5 Q19 16.5 17.5 15.5Z"/>
    </svg>
  )
}

export function IcoDM({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3L21 8V16L12 21L3 16V8L12 3Z" opacity="0.9"/>
      <path d="M12 7L17 10V14L12 17L7 14V10L12 7Z" fill="none"
            stroke="currentColor" strokeWidth="1.2" opacity="0.5"/>
    </svg>
  )
}

export function IcoOracle({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      {/* Oracle 标志性椭圆 + 字母 O 轮廓 */}
      <ellipse cx="12" cy="12" rx="9" ry="6.5" fill="none"
               stroke="currentColor" strokeWidth="2.4"/>
      <ellipse cx="12" cy="12" rx="5.2" ry="3.8" fill="none"
               stroke="currentColor" strokeWidth="1.6" opacity="0.55"/>
    </svg>
  )
}
