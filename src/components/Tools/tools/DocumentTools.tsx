import MarkdownIt from 'markdown-it'
import { ArrowRight, FileDown, FileInput, FileSpreadsheet, FileText, FileType2, Loader2, Presentation, Save, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { toast } from '../../../stores/toastStore'

const A4_WIDTH_PX = 794
const A4_HEIGHT_PX = Math.round(A4_WIDTH_PX * 297 / 210)
const PDF_PAGE_WIDTH_MM = 210
const PDF_PAGE_HEIGHT_MM = 297
const BODY_PADDING_TOP_PX = 68
const BODY_PADDING_BOTTOM_PX = 72
const BODY_CONTENT_HEIGHT_PX = A4_HEIGHT_PX - BODY_PADDING_TOP_PX - BODY_PADDING_BOTTOM_PX
const PAGE_FIT_TOLERANCE_PX = 3

const DOC_TO_PDF_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'html', 'htm', 'rtf', 'odt', 'ods', 'odp', 'md', 'markdown']
const PDF_TARGETS = ['docx', 'xlsx', 'pptx', 'txt']
const TEXT_EXTS = ['md', 'markdown', 'txt']

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true })

type ConvertResult = {
  path: string
  engine: string
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() || ''
}

function extName(path: string) {
  const match = baseName(path).match(/\.([^.]+)$/)
  return match?.[1]?.toLowerCase() || ''
}

function stripExt(path: string) {
  return baseName(path).replace(/\.[^.]+$/, '')
}

function escapeFileName(value: string) {
  const name = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return name || 'document'
}

function firstHeading(source: string) {
  const match = source.match(/^#\s+(.+?)\s*$/m)
  return match?.[1]?.trim() || ''
}

function styledSourceToHtml(source: string, sourceName: string) {
  const ext = extName(sourceName)
  if (ext === 'txt') {
    const escaped = source.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch))
    return `<pre>${escaped}</pre>`
  }
  return markdown.render(source)
}

function createWatermarkImage({ text, columns, rows, angle, opacity, color }: {
  text: string
  columns: number
  rows: number
  angle: number
  opacity: number
  color: string
}) {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = A4_WIDTH_PX * scale
  canvas.height = A4_HEIGHT_PX * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.scale(scale, scale)
  ctx.fillStyle = color
  ctx.globalAlpha = opacity
  ctx.font = '700 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const radians = angle * Math.PI / 180
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column + 0.5) * A4_WIDTH_PX / columns
      const y = (row + 0.5) * A4_HEIGHT_PX / rows
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(radians)
      ctx.fillText(text, 0, 0)
      ctx.restore()
    }
  }
  return canvas.toDataURL('image/png')
}

function createCoverImage({ title, subtitle, coverBg, coverTextColor, watermark }: {
  title: string
  subtitle: string
  coverBg: string
  coverTextColor: string
  watermark: { enabled: boolean; text: string; columns: number; rows: number; angle: number; opacity: number }
}) {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = A4_WIDTH_PX * scale
  canvas.height = A4_HEIGHT_PX * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.scale(scale, scale)
  ctx.fillStyle = coverBg
  ctx.fillRect(0, 0, A4_WIDTH_PX, A4_HEIGHT_PX)
  ctx.fillStyle = coverTextColor
  ctx.globalAlpha = 0.14
  ctx.fillRect(A4_WIDTH_PX * 0.71, 0, A4_WIDTH_PX * 0.29, A4_HEIGHT_PX)

  if (watermark.enabled && watermark.text.trim()) {
    ctx.save()
    ctx.fillStyle = coverTextColor
    ctx.globalAlpha = Math.min(watermark.opacity + 0.02, 0.18)
    ctx.font = '700 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const radians = watermark.angle * Math.PI / 180
    for (let row = 0; row < watermark.rows; row += 1) {
      for (let column = 0; column < watermark.columns; column += 1) {
        const x = (column + 0.5) * A4_WIDTH_PX / watermark.columns
        const y = (row + 0.5) * A4_HEIGHT_PX / watermark.rows
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(radians)
        ctx.fillText(watermark.text, 0, 0)
        ctx.restore()
      }
    }
    ctx.restore()
  }

  ctx.globalAlpha = 1
  ctx.fillStyle = coverTextColor
  ctx.fillRect(106, 210, 68, 5)
  ctx.font = '700 40px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  const maxWidth = 570
  const words = title.split('')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = `${line}${word}`
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  lines.slice(0, 4).forEach((item, index) => ctx.fillText(item, 106, 330 + index * 54))
  ctx.globalAlpha = 0.86
  ctx.font = '650 18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(subtitle || new Date().toLocaleDateString('zh-CN'), 106, 330 + Math.min(lines.length, 4) * 54 + 38)
  return canvas.toDataURL('image/png')
}

type PaginationState = {
  root: HTMLDivElement
  page: HTMLElement
  article: HTMLElement
}

function createBodyPageElement() {
  const page = document.createElement('main')
  page.className = 'mdpdf-body-page'
  const article = document.createElement('article')
  article.className = 'mdpdf-body-content'
  page.appendChild(article)
  return { page, article }
}

function addBodyPage(state: Pick<PaginationState, 'root'>) {
  const { page, article } = createBodyPageElement()
  state.root.appendChild(page)
  return { page, article }
}

function pageFits(article: HTMLElement) {
  return article.scrollHeight <= BODY_CONTENT_HEIGHT_PX + PAGE_FIT_TOLERANCE_PX
}

function appendElementToCurrentPage(state: PaginationState, element: HTMLElement) {
  state.article.appendChild(element)
  if (pageFits(state.article)) return true
  state.article.removeChild(element)
  return false
}

function moveToNextPage(state: PaginationState) {
  const next = addBodyPage(state)
  state.page = next.page
  state.article = next.article
}

function makePreSlice(original: HTMLElement, lines: string[]) {
  const pre = original.cloneNode(false) as HTMLElement
  const code = original.querySelector('code')
  if (code) {
    const codeClone = code.cloneNode(false) as HTMLElement
    codeClone.textContent = lines.join('\n')
    pre.appendChild(codeClone)
  } else {
    pre.textContent = lines.join('\n')
  }
  return pre
}

function appendSplitPre(state: PaginationState, original: HTMLElement) {
  const lines = (original.textContent || '').split('\n')
  let lineIndex = 0
  let chunk: string[] = []
  let working: HTMLElement | null = null

  while (lineIndex < lines.length) {
    const candidateChunk = [...chunk, lines[lineIndex]]
    const candidate = makePreSlice(original, candidateChunk)
    if (working) {
      working.replaceWith(candidate)
    } else {
      state.article.appendChild(candidate)
    }

    if (pageFits(state.article)) {
      working = candidate
      chunk = candidateChunk
      lineIndex += 1
      continue
    }

    candidate.remove()
    if (working) {
      moveToNextPage(state)
      working = null
      chunk = []
      continue
    }
    if (state.article.childElementCount > 0) {
      moveToNextPage(state)
      continue
    }
    state.article.appendChild(makePreSlice(original, [lines[lineIndex]]))
    lineIndex += 1
    if (lineIndex < lines.length) moveToNextPage(state)
  }
}

function makeTableSlice(original: HTMLTableElement, rows: HTMLTableRowElement[]) {
  const table = original.cloneNode(false) as HTMLTableElement
  const caption = original.querySelector(':scope > caption')
  const colgroup = original.querySelector(':scope > colgroup')
  const thead = original.querySelector(':scope > thead')
  if (caption) table.appendChild(caption.cloneNode(true))
  if (colgroup) table.appendChild(colgroup.cloneNode(true))
  if (thead) table.appendChild(thead.cloneNode(true))
  const tbody = document.createElement('tbody')
  rows.forEach(row => tbody.appendChild(row.cloneNode(true)))
  table.appendChild(tbody)
  return table
}

function appendSplitTable(state: PaginationState, original: HTMLTableElement) {
  const rows = Array.from(original.querySelectorAll(':scope > tbody > tr, :scope > tr')) as HTMLTableRowElement[]
  if (rows.length === 0) {
    appendElementToCurrentPage(state, original.cloneNode(true) as HTMLElement)
    return
  }

  let rowIndex = 0
  let chunk: HTMLTableRowElement[] = []
  let working: HTMLElement | null = null

  while (rowIndex < rows.length) {
    const candidateChunk = [...chunk, rows[rowIndex]]
    const candidate = makeTableSlice(original, candidateChunk)
    if (working) {
      working.replaceWith(candidate)
    } else {
      state.article.appendChild(candidate)
    }

    if (pageFits(state.article)) {
      working = candidate
      chunk = candidateChunk
      rowIndex += 1
      continue
    }

    candidate.remove()
    if (working) {
      moveToNextPage(state)
      working = null
      chunk = []
      continue
    }
    if (state.article.childElementCount > 0) {
      moveToNextPage(state)
      continue
    }
    state.article.appendChild(makeTableSlice(original, [rows[rowIndex]]))
    rowIndex += 1
    if (rowIndex < rows.length) moveToNextPage(state)
  }
}

function makeListSlice(original: HTMLElement, items: HTMLElement[]) {
  const list = original.cloneNode(false) as HTMLElement
  items.forEach(item => list.appendChild(item.cloneNode(true)))
  return list
}

function appendSplitList(state: PaginationState, original: HTMLElement) {
  const items = Array.from(original.children) as HTMLElement[]
  if (items.length === 0) {
    appendElementToCurrentPage(state, original.cloneNode(true) as HTMLElement)
    return
  }

  let itemIndex = 0
  let chunk: HTMLElement[] = []
  let working: HTMLElement | null = null

  while (itemIndex < items.length) {
    const candidateChunk = [...chunk, items[itemIndex]]
    const candidate = makeListSlice(original, candidateChunk)
    if (working) {
      working.replaceWith(candidate)
    } else {
      state.article.appendChild(candidate)
    }

    if (pageFits(state.article)) {
      working = candidate
      chunk = candidateChunk
      itemIndex += 1
      continue
    }

    candidate.remove()
    if (working) {
      moveToNextPage(state)
      working = null
      chunk = []
      continue
    }
    if (state.article.childElementCount > 0) {
      moveToNextPage(state)
      continue
    }
    state.article.appendChild(makeListSlice(original, [items[itemIndex]]))
    itemIndex += 1
    if (itemIndex < items.length) moveToNextPage(state)
  }
}

function appendPaginatedBlock(state: PaginationState, original: HTMLElement) {
  const tag = original.tagName.toLowerCase()
  const clone = original.cloneNode(true) as HTMLElement
  if (appendElementToCurrentPage(state, clone)) return

  if (tag === 'pre') {
    appendSplitPre(state, original)
    return
  }
  if (tag === 'table') {
    appendSplitTable(state, original as HTMLTableElement)
    return
  }
  if (tag === 'ul' || tag === 'ol') {
    appendSplitList(state, original)
    return
  }

  if (state.article.childElementCount > 0) moveToNextPage(state)
  state.article.appendChild(original.cloneNode(true) as HTMLElement)
}

function createPaginatedDocument(sourceNode: HTMLElement, host: HTMLElement) {
  const root = document.createElement('div')
  root.className = 'mdpdf-document mdpdf-document--paged'
  host.appendChild(root)
  const first = addBodyPage({ root })
  const state: PaginationState = { root, page: first.page, article: first.article }

  Array.from(sourceNode.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      if (!text) return
      const paragraph = document.createElement('p')
      paragraph.textContent = text
      appendPaginatedBlock(state, paragraph)
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      appendPaginatedBlock(state, node as HTMLElement)
    }
  })

  const pages = Array.from(root.querySelectorAll<HTMLElement>('.mdpdf-body-page'))
  const lastPage = pages[pages.length - 1]
  if (lastPage && pages.length > 1 && !lastPage.querySelector('.mdpdf-body-content')?.childElementCount) {
    lastPage.remove()
  }
  return root
}

function DocumentView({ html, preview = false }: {
  html: string
  preview?: boolean
}) {
  return (
    <div className={preview ? 'mdpdf-document mdpdf-document--preview' : 'mdpdf-document'}>
      <main className="mdpdf-body-page">
        <article className="mdpdf-body-content" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  )
}

function targetOptionsForSource(ext: string) {
  if (!ext) return ['pdf', ...PDF_TARGETS]
  if (ext === 'pdf') return PDF_TARGETS
  if (DOC_TO_PDF_EXTS.includes(ext)) return ['pdf']
  return ['pdf']
}

function formatShortLabel(ext: string) {
  if (ext === 'pdf') return 'PDF'
  if (ext === 'docx') return 'Word'
  if (ext === 'xlsx') return 'Excel'
  if (ext === 'pptx') return 'PPT'
  if (ext === 'txt') return 'TXT'
  return ext.toUpperCase()
}

function formatLabel(ext: string) {
  if (ext === 'pdf') return 'PDF 文档'
  if (ext === 'docx') return 'Word 文档'
  if (ext === 'xlsx') return 'Excel 工作簿'
  if (ext === 'pptx') return 'PPT 演示文稿'
  if (ext === 'txt') return 'TXT 文本'
  return ext.toUpperCase()
}

function targetIcon(ext: string) {
  if (ext === 'xlsx') return <FileSpreadsheet size={15} />
  if (ext === 'pptx') return <Presentation size={15} />
  if (ext === 'txt') return <FileText size={15} />
  return <FileType2 size={15} />
}

export function DocumentConvertTool() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState(() => localStorage.getItem('tool-mdpdf-draft') ?? '')
  const [sourceName, setSourceName] = useState('')
  const [inputPath, setInputPath] = useState('')
  const [targetFormat, setTargetFormat] = useState('pdf')
  const [title, setTitle] = useState(() => firstHeading(localStorage.getItem('tool-mdpdf-draft') ?? ''))
  const [subtitle, setSubtitle] = useState('文档转 PDF')
  const [coverBg, setCoverBg] = useState('#172b3f')
  const [coverTextColor, setCoverTextColor] = useState('#ffffff')
  const [enhancedPdf, setEnhancedPdf] = useState(true)
  const [watermarkEnabled, setWatermarkEnabled] = useState(false)
  const [watermarkText, setWatermarkText] = useState('')
  const [watermarkRows, setWatermarkRows] = useState(5)
  const [watermarkColumns, setWatermarkColumns] = useState(2)
  const [watermarkAngle, setWatermarkAngle] = useState(29)
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.06)
  const [busy, setBusy] = useState(false)

  const inputExt = extName(inputPath || sourceName)
  const targetOptions = useMemo(() => targetOptionsForSource(inputExt), [inputExt])
  const hasSelectedSource = Boolean(inputPath || sourceName)
  const canUseTextPdf = targetFormat === 'pdf' && hasSelectedSource && TEXT_EXTS.includes(inputExt)
  const renderedHtml = useMemo(() => styledSourceToHtml(source, sourceName), [source, sourceName])
  const effectiveTitle = title.trim() || firstHeading(source) || stripExt(sourceName || inputPath) || '文档'
  const sourceDisplayName = hasSelectedSource ? baseName(inputPath || sourceName) : '选择文件'
  const sourceDisplayPath = hasSelectedSource ? (inputPath || sourceName) : 'Word、Excel、PPT、PDF、Markdown、TXT、CSV、HTML'
  const sourceFormatLabel = inputExt ? inputExt.toUpperCase() : '自动识别'
  const hintText = inputExt === 'pdf'
    ? 'PDF 源文件可转为 Word、Excel、PPT 或 TXT。'
    : inputExt
      ? `${inputExt.toUpperCase()} 源文件当前可转为 ${targetFormat.toUpperCase()}。`
      : '导入文件后自动匹配可用目标格式。'
  const watermark = {
    enabled: watermarkEnabled,
    text: watermarkText,
    columns: watermarkColumns,
    rows: watermarkRows,
    angle: watermarkAngle,
    opacity: watermarkOpacity,
  }

  useEffect(() => {
    if (!targetOptions.includes(targetFormat)) setTargetFormat(targetOptions[0] ?? 'pdf')
  }, [targetFormat, targetOptions])

  const setStyledSource = (content: string, name = '') => {
    setSource(content)
    setSourceName(name)
    const heading = firstHeading(content)
    if (heading) setTitle(heading)
    localStorage.setItem('tool-mdpdf-draft', content)
  }

  const onFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setStyledSource(await file.text(), file.name)
    setInputPath('')
    setTargetFormat('pdf')
    toast.success(`已导入：${file.name}`)
  }

  const pickConvertFile = async () => {
    if (!isTauri()) {
      fileInputRef.current?.click()
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        title: '选择要转换的文档',
        filters: [{ name: '文档文件', extensions: ['pdf', ...DOC_TO_PDF_EXTS] }],
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return
      setInputPath(path)
      setSourceName(path)
      const ext = extName(path)
      const opts = targetOptionsForSource(ext)
      setTargetFormat(opts[0] ?? 'pdf')
      if (TEXT_EXTS.includes(ext)) {
        const { invoke } = await import('@tauri-apps/api/core')
        const content = await invoke<string>('read_local_file', { path })
        setStyledSource(content, path)
      }
    } catch (error) {
      toast.error(`选择失败：${String(error)}`)
    }
  }

  const exportStyledPdf = async () => {
    if (!source.trim()) {
      toast.error('请先选择或输入 Markdown / TXT')
      return
    }
    const node = exportRef.current
    if (!node) return
    setBusy(true)
    let paginatedDoc: HTMLElement | null = null
    try {
      const { jsPDF } = await import('jspdf')
      const html2canvas = (await import('html2canvas')).default
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
      const hasCover = enhancedPdf
      if (hasCover) {
        const cover = createCoverImage({ title: effectiveTitle, subtitle, coverBg, coverTextColor, watermark })
        if (cover) pdf.addImage(cover, 'PNG', 0, 0, PDF_PAGE_WIDTH_MM, PDF_PAGE_HEIGHT_MM, undefined, 'FAST')
      }
      await document.fonts?.ready
      const bodyContent = node.querySelector<HTMLElement>('.mdpdf-body-content')
      if (!bodyContent) throw new Error('未找到 PDF 正文内容')
      paginatedDoc = createPaginatedDocument(bodyContent, node.parentElement || document.body)
      const bodyPages = Array.from(paginatedDoc.querySelectorAll<HTMLElement>('.mdpdf-body-page'))
      const captureScale = Math.min(Math.max(window.devicePixelRatio || 1.5, 1.5), 2)
      for (let index = 0; index < bodyPages.length; index += 1) {
        const page = bodyPages[index]
        const canvas = await html2canvas(page, {
          backgroundColor: '#ffffff',
          height: A4_HEIGHT_PX,
          scale: captureScale,
          scrollX: 0,
          scrollY: 0,
          useCORS: true,
          width: A4_WIDTH_PX,
          windowHeight: A4_HEIGHT_PX,
          windowWidth: A4_WIDTH_PX,
          x: 0,
          y: 0,
        })
        if (hasCover || index > 0) pdf.addPage()
        const image = canvas.toDataURL('image/jpeg', 0.94)
        pdf.addImage(image, 'JPEG', 0, 0, PDF_PAGE_WIDTH_MM, PDF_PAGE_HEIGHT_MM, undefined, 'FAST')
      }
      pdf.setProperties({ title: effectiveTitle, subject: subtitle, creator: '文档互转' })
      if (enhancedPdf && watermark.enabled) {
        const startPage = hasCover ? 2 : 1
        const pageCount = pdf.getNumberOfPages()
        const mark = createWatermarkImage({ ...watermark, color: '#1f2328' })
        if (mark) {
          for (let page = startPage; page <= pageCount; page += 1) {
            pdf.setPage(page)
            pdf.addImage(mark, 'PNG', 0, 0, PDF_PAGE_WIDTH_MM, PDF_PAGE_HEIGHT_MM, undefined, 'FAST')
          }
        }
      }
      const defaultPath = `${escapeFileName(effectiveTitle)}.pdf`
      if (isTauri()) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({ title: '保存 PDF', defaultPath, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
        if (!path) return
        const { invoke } = await import('@tauri-apps/api/core')
        const bytes = new Uint8Array(pdf.output('arraybuffer'))
        await invoke('write_local_bytes', { path, bytes: Array.from(bytes) })
        toast.success(`PDF 已保存：${path}`)
      } else {
        pdf.save(defaultPath)
        toast.success(`PDF 已生成：${defaultPath}`)
      }
    } catch (error) {
      toast.error(`导出失败：${String(error)}`)
    } finally {
      paginatedDoc?.remove()
      setBusy(false)
    }
  }

  const convertFile = async () => {
    if (canUseTextPdf) {
      await exportStyledPdf()
      return
    }
    if (!inputPath) {
      toast.error('请先选择源文件')
      return
    }
    if (!isTauri()) {
      toast.error('文件互转需要在桌面应用中使用')
      return
    }
    setBusy(true)
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const outputPath = await save({
        title: '保存转换结果',
        defaultPath: `${stripExt(inputPath)}.${targetFormat}`,
        filters: [{ name: formatLabel(targetFormat), extensions: [targetFormat] }],
      })
      if (!outputPath) return
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<ConvertResult>('convert_document_file', {
        inputPath,
        outputPath,
        outputFormat: targetFormat,
      })
      toast.success(`转换完成：${result.path}`)
    } catch (error) {
      toast.error(`转换失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="docconvert-tool">
      <input ref={fileInputRef} className="mdpdf-file-input" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.html,.htm,.rtf,.odt,.ods,.odp,.md,.markdown,text/markdown,text/plain" onChange={onFileInput} />
      <div className="tool-shell">
        <section className="docconvert-workbench">
          <div className={`docconvert-taskbar ${hasSelectedSource ? 'has-source' : ''}`}>
            <button className={`docconvert-import ${hasSelectedSource ? 'has-file' : ''}`} onClick={pickConvertFile}>
              <span className="docconvert-import__icon"><FileInput size={18} /></span>
              <span className="docconvert-import__body">
                <span>源文件</span>
                <strong>{sourceDisplayName}</strong>
                <small>{sourceDisplayPath}</small>
              </span>
            </button>

            {hasSelectedSource && (
              <div className="docconvert-route" aria-label="转换方向">
                <span>{sourceFormatLabel}</span>
                <ArrowRight size={16} />
                <strong>{formatShortLabel(targetFormat)}</strong>
              </div>
            )}
          </div>

          <div className="docconvert-formatbar">
            <div className="docconvert-formatbar__label">目标格式</div>
            <div className="docconvert-targets">
              {targetOptions.map(ext => (
                <button key={ext} className={targetFormat === ext ? 'active' : ''} onClick={() => setTargetFormat(ext)}>
                  {targetIcon(ext)}
                  {formatShortLabel(ext)}
                </button>
              ))}
            </div>
          </div>

          {canUseTextPdf && (
            <div className="docconvert-pdf-options">
              <div className="docconvert-pdf-options__head">
                <div>
                  <span><Settings2 size={14} />PDF 选项</span>
                  <small>Markdown / TXT 转 PDF 时可设置水印和首页背景</small>
                </div>
                <label className="docconvert-switch">
                  <input type="checkbox" checked={enhancedPdf} onChange={event => setEnhancedPdf(event.target.checked)} />
                  启用增强
                </label>
              </div>

              {enhancedPdf && (
                <div className="docconvert-pdf-options__body">
                  <div className="docconvert-settings-grid">
                    <label className="tool-field">
                      <span>首页标题</span>
                      <input className="tool-input" value={title} onChange={event => setTitle(event.target.value)} placeholder="默认使用第一个一级标题" />
                    </label>
                    <label className="tool-field">
                      <span>副标题</span>
                      <input className="tool-input" value={subtitle} onChange={event => setSubtitle(event.target.value)} />
                    </label>
                    <label className="tool-field">
                      <span>首页背景色</span>
                      <input className="tool-input mdpdf-color-input" type="color" value={coverBg} onChange={event => setCoverBg(event.target.value)} />
                    </label>
                    <label className="tool-field">
                      <span>首页文字色</span>
                      <input className="tool-input mdpdf-color-input" type="color" value={coverTextColor} onChange={event => setCoverTextColor(event.target.value)} />
                    </label>
                    <label className="tool-check docconvert-check">
                      <input type="checkbox" checked={watermarkEnabled} onChange={event => setWatermarkEnabled(event.target.checked)} />
                      水印
                    </label>
                    <label className="tool-field">
                      <span>水印文字</span>
                      <input className="tool-input" value={watermarkText} onChange={event => setWatermarkText(event.target.value)} disabled={!watermarkEnabled} />
                    </label>
                    <label className="tool-field">
                      <span>列数</span>
                      <input className="tool-input" type="number" min={1} max={5} step={1} value={watermarkColumns} onChange={event => setWatermarkColumns(Number(event.target.value) || 2)} disabled={!watermarkEnabled} />
                    </label>
                    <label className="tool-field">
                      <span>行数</span>
                      <input className="tool-input" type="number" min={1} max={8} step={1} value={watermarkRows} onChange={event => setWatermarkRows(Number(event.target.value) || 5)} disabled={!watermarkEnabled} />
                    </label>
                    <label className="tool-field">
                      <span>角度</span>
                      <input className="tool-input" type="number" min={-60} max={60} step={1} value={watermarkAngle} onChange={event => setWatermarkAngle(Number(event.target.value) || 0)} disabled={!watermarkEnabled} />
                    </label>
                    <label className="tool-field">
                      <span>透明度</span>
                      <input className="tool-input" type="number" min={0.01} max={0.25} step={0.01} value={watermarkOpacity} onChange={event => setWatermarkOpacity(Number(event.target.value) || 0.06)} disabled={!watermarkEnabled} />
                    </label>
                  </div>

                  <div className="docconvert-text-editor">
                    <div className="docconvert-text-editor__head">
                      <span>Markdown / TXT 内容</span>
                      <button onClick={exportStyledPdf} disabled={busy || !source.trim()}><Save size={13} />导出当前内容</button>
                    </div>
                    <textarea
                      className="tool-textarea"
                      value={source}
                      placeholder="选择 Markdown / TXT 文件后可在这里调整内容..."
                      spellCheck={false}
                      onChange={(event) => {
                        const value = event.target.value
                        setSource(value)
                        localStorage.setItem('tool-mdpdf-draft', value)
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {hasSelectedSource && !canUseTextPdf && targetFormat === 'pdf' && (
            <div className="docconvert-pdf-note">
              <Settings2 size={14} />
              <div>
                <strong>PDF 增强选项</strong>
                <span>Office、Excel、PPT 等文件转 PDF 走本机转换器；水印和首页背景当前用于 Markdown / TXT 转 PDF。</span>
              </div>
            </div>
          )}

          <div className="docconvert-action-row">
            <span className="docconvert-action-row__hint">{hintText}</span>
            <button className="docconvert-run-btn" onClick={convertFile} disabled={busy || !hasSelectedSource}>
              {busy ? <Loader2 size={16} className="spin" /> : <FileDown size={16} />}
              {busy ? '转换中...' : `开始转换`}
            </button>
          </div>
        </section>
      </div>

          <div className="mdpdf-export-host" aria-hidden="true">
        <div ref={exportRef}>
          <DocumentView html={renderedHtml} />
        </div>
      </div>
    </div>
  )
}
