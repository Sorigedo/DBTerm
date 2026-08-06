import { ALargeSmall, Binary, Braces, Code2, FileDown, Fingerprint, GitCompare, Hash, KeyRound, Link, Palette, Regex, Shield, TextCursorInput, Timer, type LucideIcon } from 'lucide-react'
import type { ToolId } from '../../types'

export interface ToolInfo {
  id: ToolId
  title: string
  desc: string
  Icon: LucideIcon
}

export const TOOLS: ToolInfo[] = [
  { id: 'json', title: 'JSON 格式化', desc: '格式化、压缩与校验 JSON', Icon: Braces },
  { id: 'base64', title: 'Base64 编解码', desc: '文本 Base64 编码与解码', Icon: Code2 },
  { id: 'url', title: 'URL 编解码', desc: 'URL 编码、解码与参数解析', Icon: Link },
  { id: 'timestamp', title: '时间戳转换', desc: '秒/毫秒时间戳与本地时间互转', Icon: Timer },
  { id: 'uuid', title: 'UUID 生成', desc: '批量生成 UUID v4', Icon: Fingerprint },
  { id: 'hash', title: 'Hash 计算', desc: 'SHA-1 / SHA-256 / SHA-384 / SHA-512', Icon: Hash },
  { id: 'jwt', title: 'JWT 解析', desc: '解析 Header 与 Payload', Icon: KeyRound },
  { id: 'regex', title: '正则测试', desc: '匹配、分组与替换预览', Icon: Regex },
  { id: 'color', title: '颜色转换', desc: 'HEX / RGB / HSL 转换', Icon: Palette },
  { id: 'text', title: '文本统计', desc: '字符、单词、行数与字节统计', Icon: TextCursorInput },
  { id: 'password', title: '随机密码', desc: '生成密码、Token 与 PIN', Icon: Shield },
  { id: 'case', title: '大小写转换', desc: '驼峰、下划线、短横线与标题格式', Icon: ALargeSmall },
  { id: 'diff', title: '文本对比', desc: '逐行比较两段文本差异', Icon: GitCompare },
  { id: 'number', title: '进制转换', desc: '二进制、八进制、十进制、十六进制互转', Icon: Binary },
  { id: 'documentConvert', title: '文档互转', desc: 'Word / Excel / PPT / TXT / MD / PDF 互转', Icon: FileDown },
]

export function getToolInfo(id: ToolId): ToolInfo {
  return TOOLS.find(t => t.id === id) ?? TOOLS[0]
}
