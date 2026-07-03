const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g

export function stripTerminalControls(text: string): string {
  return text
    .replace(OSC_RE, '')
    .replace(ANSI_RE, '')
    .replace(/\x1b[>=]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

export function stripShellPrompt(line: string): string {
  const text = stripTerminalControls(line).replace(/\s+$/g, '')
  const markers = ['# ', '$ ', '% ']
  let idx = -1
  for (const marker of markers) {
    idx = Math.max(idx, text.lastIndexOf(marker))
  }
  if (idx >= 0) return text.slice(idx + 2).trim()
  const compactMatch = text.match(/^.*(?:[\]})~:/\\]|[A-Za-z0-9_-])([#$%])(.+)$/)
  if (compactMatch) return compactMatch[2].trim()
  return text.trim()
}

export function isRecordableShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length <= 1) return false
  if (/^\[[^\]]+\]$/.test(trimmed)) return false
  if (/^(?:clear|reset|exit|logout)$/.test(trimmed)) return true
  return /[A-Za-z0-9_./~-]/.test(trimmed)
}

export function commandsFromInputData(data: string): string[] {
  const clean = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
  if (!/[\r\n]/.test(clean) || clean.includes('\x1b')) return []
  return clean
    .split(/[\r\n]+/)
    .map((cmd) => cmd.trim())
    .filter(isRecordableShellCommand)
}
