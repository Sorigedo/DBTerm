import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface Props {
  /** 出错区域名称，用于提示 */
  label?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 局部错误边界：捕获子树渲染异常，避免单个面板崩溃导致整个应用白屏
 * （白屏会连带卸载全局快捷键监听器）。出错时展示错误详情并可重试。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 控制台保留完整堆栈，便于定位
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: 32, color: 'var(--text)', overflow: 'auto',
      }}>
        <AlertTriangle size={36} color="var(--error)" strokeWidth={1.6} />
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>
          此面板渲染出错{this.props.label ? `（${this.props.label}）` : ''}
        </div>
        <pre style={{
          maxWidth: 640, maxHeight: 220, overflow: 'auto', margin: 0,
          fontSize: 12, lineHeight: 1.6, color: 'var(--error)',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '12px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button onClick={this.reset} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
        }}>
          <RotateCcw size={14} /> 重试
        </button>
      </div>
    )
  }
}
