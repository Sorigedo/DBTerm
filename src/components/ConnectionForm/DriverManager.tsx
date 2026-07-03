// 驱动管理面板
// filterType: 传入则只展示该驱动（连接表单内聚焦模式），不传则全量（Settings 独立页）
import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  CheckCircle2, XCircle, AlertTriangle, Download, FolderOpen,
  Trash2, RefreshCw, Loader2, Globe, ChevronDown, ChevronUp, Terminal, ExternalLink,
} from 'lucide-react'

const MIRROR_KEY = 'dbterm_driver_mirror_url'
function loadMirror(): string { return localStorage.getItem(MIRROR_KEY) ?? '' }
function saveMirror(url: string) {
  if (url.trim()) localStorage.setItem(MIRROR_KEY, url.trim())
  else localStorage.removeItem(MIRROR_KEY)
}

interface PlatformDownload { url: string; sha256: string; fileName: string }
interface DriverVersion {
  version: string; label: string
  winX64?: PlatformDownload; linuxX64?: PlatformDownload; macArm64?: PlatformDownload
  openAfterDownload: boolean   // 下载后用系统程序打开（MSI）而非作为驱动路径
  macCmd?: string              // macOS: brew install ...
  linuxCmd?: string            // Linux: apt-get install ...
}
interface DriverMeta {
  driverType: string; kind: 'dylib' | 'odbc'
  displayName: string; vendor: string; notes: string; manualOnly: boolean
  installGuideUrl?: string
  winX64?: PlatformDownload; linuxX64?: PlatformDownload; macArm64?: PlatformDownload
  minVersion: string; systemPrereq: string
  versions: DriverVersion[]
}
interface DriverState {
  meta: DriverMeta
  status: Record<string, unknown> | string
  customPath?: string
  loadError?: string
}
interface DownloadProgress {
  driverType: string; downloaded: number; total: number; done: boolean; error?: string
}

function isReady(status: unknown, loadError?: string): boolean {
  if (loadError) return false   // 文件损坏时不算就绪，即使路径存在
  const s = status as Record<string, unknown>
  return s?.ready === true || status === 'ready' || s?.availableAt !== undefined
}
function isAvailableAt(status: unknown): boolean {
  return (status as Record<string, unknown>)?.availableAt !== undefined
}

interface Props { filterType?: string; embedded?: boolean }

export default function DriverManager({ filterType, embedded = false }: Props) {
  const [drivers, setDrivers]         = useState<DriverState[]>([])
  const [loading, setLoading]         = useState(false)
  const [probing, setProbing]         = useState(false)
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({})
  const [selVersion, setSelVersion]   = useState<Record<string, string>>({})
  const [cmdOutput, setCmdOutput]     = useState<Record<string, string[]>>({})  // driverType → log lines
  const [cmdRunning, setCmdRunning]   = useState<Record<string, boolean>>({})
  const [currentOs, setCurrentOs]     = useState<'macos' | 'windows' | 'linux' | ''>('')
  const [pathEdit, setPathEdit]       = useState<Record<string, string>>({})
  const [mirrorUrl, setMirrorUrl]     = useState(loadMirror)
  const [mirrorEdit, setMirrorEdit]   = useState(loadMirror)
  const [showMirror, setShowMirror]   = useState(false)
  const [showPath, setShowPath]       = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try { setDrivers(await invoke<DriverState[]>('dr_list')) }
    catch (e) { console.error('dr_list', e) }
    finally { setLoading(false) }
  }, [])

  const probe = useCallback(async () => {
    setProbing(true)
    try { setDrivers(await invoke<DriverState[]>('dr_probe_all')) }
    catch (e) { console.error('dr_probe_all', e) }
    finally { setProbing(false) }
  }, [])

  // mirrorUrl ref：让 listen 回调始终取最新值，避免旧闭包
  const mirrorUrlRef = useRef(mirrorUrl)
  useEffect(() => { mirrorUrlRef.current = mirrorUrl }, [mirrorUrl])

  useEffect(() => {
    load()
    invoke<string>('current_os').then(os => setCurrentOs(os as 'macos' | 'windows' | 'linux')).catch(() => {})
    let cancelled = false
    let unlisten: (() => void) | null = null
    let unlistenCmd: (() => void) | null = null

    listen<DownloadProgress>('driver-download-progress', e => {
      if (cancelled) return
      const p = e.payload
      if (p.done) {
        setDownloading(prev => { const n = { ...prev }; delete n[p.driverType]; return n })
        invoke<DriverState>('dr_probe_one', { driverType: p.driverType })
          .then(s => setDrivers(prev => prev.map(d => d.meta.driverType === s.meta.driverType ? s : d)))
          .catch(err => console.error('probe failed after download', err))
        if (p.error) {
          if (p.error.includes('SHA-256') || p.error.includes('未校验')) {
            setTimeout(() => {
              if (confirm(`${p.error}\n\n该驱动无官方校验和，无法验证完整性。确定继续下载？`)) {
                invoke('dr_download', { driverType: p.driverType, mirrorUrl: mirrorUrlRef.current.trim() || null, allowUnverified: true })
                  .catch(err => alert(`下载失败: ${err}`))
              }
            }, 50)
          } else {
            setTimeout(() => alert(`下载失败: ${p.error}`), 50)
          }
        }
      } else {
        setDownloading(prev => ({ ...prev, [p.driverType]: p }))
      }
    }).then(f => { if (cancelled) f(); else unlisten = f }).catch(console.error)

    // 命令输出事件（brew/apt）
    listen<{ driverType: string; line: string; done: boolean; exitOk: boolean }>('driver-cmd-output', e => {
      if (cancelled) return
      const p = e.payload
      if (p.done) {
        setCmdRunning(prev => { const n = { ...prev }; delete n[p.driverType]; return n })
        if (p.exitOk) {
          invoke<DriverState>('dr_probe_one', { driverType: p.driverType })
            .then(s => setDrivers(prev => prev.map(d => d.meta.driverType === s.meta.driverType ? s : d)))
            .catch(() => {})
        }
      } else if (p.line) {
        setCmdOutput(prev => ({ ...prev, [p.driverType]: [...(prev[p.driverType] ?? []).slice(-200), p.line] }))
      }
    }).then(f => { if (cancelled) f(); else unlistenCmd = f }).catch(console.error)

    return () => { cancelled = true; unlisten?.(); unlistenCmd?.() }
  }, [load])

  async function setPath(driverType: string) {
    const path = pathEdit[driverType]?.trim()
    if (!path) return
    try {
      const s = await invoke<DriverState>('dr_set_path', { driverType, path })
      setDrivers(prev => prev.map(d => d.meta.driverType === driverType ? s : d))
      setPathEdit(prev => { const n = { ...prev }; delete n[driverType]; return n })
      setShowPath(prev => ({ ...prev, [driverType]: false }))
    } catch (e) { alert(`设置路径失败: ${e}`) }
  }

  async function clearPath(driverType: string) {
    try {
      const s = await invoke<DriverState>('dr_clear_path', { driverType })
      setDrivers(prev => prev.map(d => d.meta.driverType === driverType ? s : d))
    } catch (e) { alert(`清除路径失败: ${e}`) }
  }

  async function startDownload(driverType: string) {
    setDownloading(prev => ({ ...prev, [driverType]: { driverType, downloaded: 0, total: 0, done: false } }))
    try {
      await invoke('dr_download', { driverType, mirrorUrl: mirrorUrl.trim() || null })
    } catch (e) {
      setDownloading(prev => { const n = { ...prev }; delete n[driverType]; return n })
      alert(`下载失败: ${e}`)
    }
  }

  async function runCmd(driverType: string, cmd: string) {
    setCmdOutput(prev => ({ ...prev, [driverType]: [] }))
    setCmdRunning(prev => ({ ...prev, [driverType]: true }))
    try {
      await invoke('dr_run_cmd', { driverType, cmd })
    } catch (e) {
      setCmdRunning(prev => { const n = { ...prev }; delete n[driverType]; return n })
      alert(`命令启动失败: ${e}`)
    }
  }

  async function startDownloadVersion(driverType: string, ver: DriverVersion) {
    setDownloading(prev => ({ ...prev, [driverType]: { driverType, downloaded: 0, total: 0, done: false } }))
    try {
      await invoke('dr_download_version', {
        driverType,
        version: ver.version,
        mirrorUrl: mirrorUrl.trim() || null,
      })
    } catch (e) {
      setDownloading(prev => { const n = { ...prev }; delete n[driverType]; return n })
      alert(`下载失败: ${e}`)
    }
  }

  async function pickFile(driverType: string) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const sel = await open({ multiple: false, title: '选择驱动文件' })
      if (typeof sel === 'string') setPathEdit(prev => ({ ...prev, [driverType]: sel }))
    } catch { /* 用户取消 */ }
  }

  if (loading) return (
    <div style={{ padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
      <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> 探测驱动状态…
    </div>
  )

  const focused = !!filterType
  const visibleDrivers = filterType ? drivers.filter(d => d.meta.driverType === filterType) : drivers
  const readyCount = visibleDrivers.filter(d => isReady(d.status, d.loadError)).length

  return (
    <div className={`driver-manager${embedded ? ' driver-manager--embedded' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── 顶部工具栏 ──────────────────────────────────────── */}
      <div style={{ padding: embedded ? '0 0 10px' : focused ? '14px 16px 10px' : '16px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: embedded ? 'none' : '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {focused
            ? '此类型需要安装外部驱动才能建立连接'
            : embedded
              ? `${readyCount}/${visibleDrivers.length} 个外部驱动可用；无须驱动的数据库类型不会显示在这里`
              : 'DuckDB · 达梦 · SQL Server 需要外部驱动，其余类型无需此操作'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 16 }}>
          <button onClick={() => setShowMirror(v => !v)} style={btnStyle(mirrorUrl ? 'accent' : 'ghost')}>
            <Globe size={11} />
            {mirrorUrl ? '镜像已配置' : '镜像源'}
            {showMirror ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
          <button onClick={probe} disabled={probing} style={btnStyle('ghost')}>
            {probing ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />}
            重新探测
          </button>
        </div>
      </div>

      {/* ── 镜像源配置（折叠） ───────────────────────────────── */}
      {showMirror && (
        <div style={{ padding: '12px 16px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            企业内网驱动镜像根 URL（留空使用官方源）：
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={mirrorEdit} onChange={e => setMirrorEdit(e.target.value)}
              placeholder="http://nas.corp/drivers"
              style={inputStyle}
            />
            <button onClick={() => { saveMirror(mirrorEdit); setMirrorUrl(mirrorEdit.trim()); setShowMirror(false) }} style={btnStyle('primary')}>保存</button>
            <button onClick={() => { setMirrorEdit(''); saveMirror(''); setMirrorUrl('') }} style={btnStyle('ghost')}>清除</button>
          </div>
        </div>
      )}

      {/* ── 驱动卡片 ─────────────────────────────────────────── */}
      <div style={{ padding: embedded ? 0 : focused ? '12px 16px' : '16px 20px', display: 'flex', flexDirection: 'column', gap: embedded ? 10 : 12 }}>
        {visibleDrivers.map(d => {
          const dt = d.meta.driverType
          const dl = downloading[dt]
          const ready = isReady(d.status, d.loadError)
          const avail = isAvailableAt(d.status)
          const showingPath = showPath[dt]
          const noteLines = embedded ? d.meta.notes.split('\n').slice(0, 1) : d.meta.notes.split('\n')

          return (
            <div key={dt} style={cardStyle(ready, avail, embedded)}>
              {/* 卡片头：状态 + 名称 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: embedded ? 4 : 6 }}>
                {ready
                  ? <CheckCircle2 size={16} color="#16a34a" />
                  : avail
                    ? <AlertTriangle size={16} color="#ea580c" />
                    : <XCircle size={16} color="#dc2626" />
                }
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>{d.meta.displayName}</span>
                <span style={kindBadge}>{d.meta.kind === 'dylib' ? '动态库' : 'ODBC'}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500,
                  color: ready ? '#16a34a' : (avail && d.loadError) ? '#dc2626' : avail ? '#ea580c' : '#dc2626' }}>
                  {ready ? '就绪' : (avail && d.loadError) ? '驱动损坏' : avail ? '文件存在' : '未安装'}
                </span>
              </div>

              {/* 说明文字（按 \n 分行） */}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: embedded ? 8 : 12, lineHeight: 1.6, paddingLeft: 26 }}>
                {noteLines.map((line, i) => (
                  <span key={i} style={{ display: 'block' }}>{line}</span>
                ))}
              </div>

              {/* 已配置路径（就绪时显示） */}
              {d.customPath && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingLeft: 26,
                  padding: '6px 10px 6px 26px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                  <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.customPath}
                  </span>
                  <button onClick={() => clearPath(dt)} title="清除路径"
                    style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              )}

              {/* 下载进度条 */}
              {dl && !dl.done && (
                <div style={{ paddingLeft: 26, marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                    <span>正在下载…</span>
                    <span>{dl.total > 0 ? `${(dl.downloaded / 1024 / 1024).toFixed(1)} / ${(dl.total / 1024 / 1024).toFixed(1)} MB` : `${(dl.downloaded / 1024).toFixed(0)} KB`}</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2,
                      width: dl.total > 0 ? `${(dl.downloaded / dl.total * 100).toFixed(0)}%` : '40%',
                      transition: 'width 0.3s' }} />
                  </div>
                </div>
              )}

              {/* 诊断信息：只要有错误就显示，不受 ready 状态影响 */}
              {d.loadError && (
                <div style={{ marginBottom: 10, marginLeft: 26, padding: '8px 12px', borderRadius: 8,
                  background: 'var(--surface-2)', borderLeft: '2px solid #dc2626' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <AlertTriangle size={11} /> 诊断
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {d.loadError}
                  </pre>
                </div>
              )}

              {/* 操作区 */}
              <div style={{ paddingLeft: embedded ? 0 : 26, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* 版本选择器（有多版本时显示） */}
                {d.meta.versions.length > 0 && (() => {
                  const curVer = selVersion[dt] ?? d.meta.versions[0]?.version ?? ''
                  const verObj = d.meta.versions.find(v => v.version === curVer) ?? d.meta.versions[0]
                  const platformCmd = currentOs === 'macos' ? verObj?.macCmd
                    : currentOs === 'linux' ? verObj?.linuxCmd : undefined
                  const hasPlatformDownload = currentOs === 'windows' ? !!verObj?.winX64
                    : currentOs === 'macos' ? !!verObj?.macArm64
                    : currentOs === 'linux' ? !!verObj?.linuxX64 : false
                  const isRunning = !!cmdRunning[dt]
                  const output = cmdOutput[dt] ?? []
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select value={curVer}
                          onChange={e => setSelVersion(prev => ({ ...prev, [dt]: e.target.value }))}
                          style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}>
                          {d.meta.versions.map(v => <option key={v.version} value={v.version}>{v.label}</option>)}
                        </select>
                        {/* macOS/Linux：跑 brew/apt 命令（已就绪时隐藏） */}
                        {platformCmd && !isRunning && !dl && !ready && (
                          <button onClick={() => runCmd(dt, platformCmd)} style={btnStyle('primary')}>
                            <Download size={12} /> 一键安装
                          </button>
                        )}
                        {/* 有平台包：直接下载 */}
                        {!platformCmd && hasPlatformDownload && !dl && !isRunning && !ready && (
                          <button onClick={() => startDownloadVersion(dt, verObj)} style={btnStyle('primary')}>
                            <Download size={12} /> 下载
                          </button>
                        )}
                        {/* 当前平台无自动包（如 macOS ARM Oracle）：提示手动安装 */}
                        {!platformCmd && !hasPlatformDownload && !ready && d.meta.installGuideUrl && (
                          <a href={d.meta.installGuideUrl} target="_blank" rel="noreferrer"
                            style={{ ...btnStyle('ghost'), textDecoration: 'none', fontSize: 11 }}>
                            <ExternalLink size={11} /> 官网下载
                          </a>
                        )}
                        {/* 已就绪：提供重新下载入口（可选） */}
                        {ready && !isRunning && !dl && (
                          <button onClick={() => {
                            if (platformCmd) runCmd(dt, platformCmd)
                            else startDownloadVersion(dt, verObj)
                          }} style={{ ...btnStyle('ghost'), fontSize: 11 }}>
                            <RefreshCw size={11} /> 重新下载
                          </button>
                        )}
                        {isRunning && (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> 安装中…
                          </span>
                        )}
                      </div>
                      {/* 命令输出控制台 */}
                      {(isRunning || output.length > 0) && (
                        <div style={{ background: '#0d1117', borderRadius: 6, padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, color: '#d0d7de', maxHeight: 140, overflowY: 'auto', lineHeight: 1.5 }}>
                          {output.map((l, i) => <div key={i}>{l}</div>)}
                          {isRunning && <div style={{ color: '#58a6ff' }}>▌</div>}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* 主操作按钮行（无版本列表时显示） */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {!d.meta.manualOnly && d.meta.versions.length === 0 && !dl && (
                    <button onClick={() => startDownload(dt)} style={btnStyle('primary')}>
                      <Download size={12} /> 自动下载
                    </button>
                  )}
                  {d.meta.manualOnly && d.meta.versions.length === 0 && d.meta.installGuideUrl && (
                    <button
                      onClick={() => invoke('open_url', { url: d.meta.installGuideUrl }).catch(console.error)}
                      style={btnStyle('primary')}>
                      <ExternalLink size={12} /> 安装指引
                    </button>
                  )}
                  <button onClick={() => setShowPath(prev => ({ ...prev, [dt]: !showingPath }))} style={btnStyle('secondary')}>
                    <FolderOpen size={12} /> 手动指定
                    {showingPath ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </button>
                  {ready && (
                    <span style={{ fontSize: 11, color: '#16a34a', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <CheckCircle2 size={11} /> 已就绪，可直接保存
                    </span>
                  )}
                </div>

                {/* 手动路径输入（折叠） */}
                {showingPath && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={pathEdit[dt] ?? ''}
                      onChange={e => setPathEdit(prev => ({ ...prev, [dt]: e.target.value }))}
                      placeholder={d.meta.kind === 'odbc' ? 'ODBC 驱动名 或 驱动文件路径' : '驱动文件路径（.dll / .so / .dylib）'}
                      style={{ ...inputStyle, flex: 1 }}
                      onKeyDown={e => e.key === 'Enter' && setPath(dt)}
                    />
                    <button onClick={() => pickFile(dt)} title="浏览文件" style={btnStyle('ghost')}><FolderOpen size={13} /></button>
                    <button onClick={() => setPath(dt)} style={btnStyle('primary')}>确认</button>
                  </div>
                )}

                {/* 前置依赖 + 版本（紧凑一行） */}
                {(d.meta.systemPrereq || d.meta.minVersion) && (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {d.meta.systemPrereq && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Terminal size={10} /> 前置依赖：{d.meta.systemPrereq}
                      </span>
                    )}
                    {d.meta.minVersion && d.meta.minVersion !== 'any' && (
                      <span>最低版本：<strong style={{ color: 'var(--text)' }}>{d.meta.minVersion}</strong></span>
                    )}
                    {d.meta.vendor && (
                      <span>厂商：{d.meta.vendor}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Settings 全局页底部 */}
      {!focused && !embedded && (
        <div style={{ padding: '4px 20px 16px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          驱动配置后在对应连接类型的「驱动」标签页中同步生效
        </div>
      )}
    </div>
  )
}

// ── 样式工具 ─────────────────────────────────────────────────────────────────

function cardStyle(ready: boolean, avail: boolean, embedded = false): CSSProperties {
  const border = ready ? '1px solid var(--border-subtle)' : avail ? '1px solid rgba(234,88,12,0.35)' : '1px solid rgba(220,38,38,0.22)'
  return {
    border,
    borderRadius: embedded ? 10 : 12,
    padding: embedded ? '12px 14px' : '14px 14px 12px',
    background: embedded ? 'var(--surface-2)' : 'var(--surface)',
    transition: 'border-color 0.2s',
  }
}

function btnStyle(variant: 'primary' | 'secondary' | 'ghost' | 'accent'): CSSProperties {
  const base: CSSProperties = { padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', transition: 'opacity 0.15s' }
  if (variant === 'primary')   return { ...base, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }
  if (variant === 'secondary') return { ...base, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }
  if (variant === 'accent')    return { ...base, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)' }
  return { ...base, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }
}

const inputStyle: CSSProperties = {
  padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8,
  background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12,
  fontFamily: 'var(--font-mono)', outline: 'none',
}

const kindBadge: CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', padding: '1px 7px',
  borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
}
