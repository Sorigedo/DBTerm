import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 根据系统在 <html> 加 is-mac 类，供 CSS 按平台切换快捷键提示文字
const _uad = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData
const _isMac = _uad?.platform === 'macOS' || /Mac|iPhone|iPod|iPad/i.test(navigator.platform || '')
if (_isMac) document.documentElement.classList.add('is-mac')

// 禁用 WebView 默认右键菜单（Reload / Inspect Element 等英文系统菜单）
document.addEventListener('contextmenu', (e) => e.preventDefault())

// 全局关闭 WebView 表单自动填充浮窗 / 首字母自动大写 / 自动纠错 / 拼写检查：
// WKWebView 默认会对文本输入框弹出"历史/联系人"填充浮窗，并把首字母转成大写，
// 这里统一在所有现有及后续动态插入的 input/textarea 上关闭，免去逐个组件设置。
function hardenInput(el: Element) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  // 跳过明确需要填充的字段（如标注了 data-allow-autofill 的密码/账号）
  if (el.dataset.allowAutofill !== undefined) return
  if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off')
  el.setAttribute('autocapitalize', 'off')
  el.setAttribute('autocorrect', 'off')
  el.setAttribute('spellcheck', 'false')
}
function hardenWithin(node: Node) {
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) hardenInput(node)
  else if (node instanceof Element) node.querySelectorAll('input, textarea').forEach(hardenInput)
}
hardenWithin(document.documentElement)
new MutationObserver((muts) => {
  for (const m of muts) m.addedNodes.forEach(hardenWithin)
}).observe(document.documentElement, { childList: true, subtree: true })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
)
