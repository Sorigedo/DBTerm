import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RefreshCw, Loader2, Activity, X, ChevronDown, ChevronRight,
  Cpu, HardDrive, Network, List, XCircle,
} from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'

interface ProcessInfo {
  pid: number
  name: string
  cpuPct: number
  memMb: number
  status: string
}

interface DiskEntry {
  mount: string
  total: number
  used: number
}

interface ServerPerf {
  hostname: string
  username: string
  uptime: string
  os: string
  ip: string
  cpuTotal: number
  cpuCores: number[]
  cpuCount: number
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  diskTotal: number
  diskUsed: number
  disks: DiskEntry[]
  netRx: number
  netTx: number
  processes: ProcessInfo[]
}

interface Props {
  sessionId: string
  onClose: () => void
}

function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="perf-bar">
      <div className="perf-bar__fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  )
}

function fmt(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function cpuColor(pct: number): string {
  if (pct < 50) return 'var(--success)'
  if (pct < 80) return 'var(--warning)'
  return 'var(--error)'
}

function Section({
  icon, title, right, open, onToggle, children,
}: {
  icon: React.ReactNode
  title: string
  right?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="perf-section">
      <button className="perf-section-title" onClick={onToggle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {icon}
          {title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {right}
          {open
            ? <ChevronDown size={11} strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
            : <ChevronRight size={11} strokeWidth={2} style={{ color: 'var(--text-muted)' }} />}
        </span>
      </button>
      {open && <div className="perf-section-body">{children}</div>}
    </div>
  )
}

export default function PerfPanel({ sessionId, onClose }: Props) {
  const [perf, setPerf]       = useState<ServerPerf | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [processSearch, setProcessSearch] = useState('')
  const [prevNet, setPrevNet] = useState<{ rx: number; tx: number } | null>(null)
  const [netRate, setNetRate] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 })
  const [open, setOpen] = useState({ cpu: false, mem: false, disk: false, net: false, proc: false })
  const [killing, setKilling] = useState<number | null>(null)
  const [dialog, setDialog] = useState<null | { title: string; desc: string; onOk: () => void }>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cpuRef  = useRef<HTMLDivElement>(null)
  const memRef  = useRef<HTMLDivElement>(null)
  const diskRef = useRef<HTMLDivElement>(null)
  const netRef  = useRef<HTMLDivElement>(null)
  const procRef = useRef<HTMLDivElement>(null)

  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }))

  const jumpTo = (key: keyof typeof open) => {
    setOpen(o => ({ ...o, [key]: !o[key] }))
  }

  const fetchPerf = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const data = await invoke<ServerPerf>('get_server_perf', { id: sessionId })
      setPerf(data)
      if (prevNet) {
        setNetRate({
          rx: Math.max(0, data.netRx - prevNet.rx),
          tx: Math.max(0, data.netTx - prevNet.tx),
        })
      }
      setPrevNet({ rx: data.netRx, tx: data.netTx })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId, loading, prevNet])

  useEffect(() => {
    fetchPerf()
    timerRef.current = setInterval(() => { if (!document.hidden) fetchPerf() }, 5000)  // 后台不可见暂停，避免空转 SSH 取数
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const killProcess = (pid: number, name: string) => {
    setDialog({
      title: '强制终止进程',
      desc: `确认强制终止 ${name}（PID ${pid}）？此操作将发送 SIGKILL，进程立即退出且无法恢复。`,
      onOk: async () => {
        setDialog(null)
        setKilling(pid)
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('kill_process', { id: sessionId, pid })
          await fetchPerf()
        } catch (e) {
          setError(String(e))
        } finally {
          setKilling(null)
        }
      },
    })
  }

  const filteredProcs = perf?.processes.filter((p) =>
    !processSearch || p.name.toLowerCase().includes(processSearch.toLowerCase())
  ) ?? []

  const memPct  = perf && perf.memTotal  > 0 ? (perf.memUsed  / perf.memTotal)  * 100 : 0
  const diskPct = perf && perf.diskTotal > 0 ? (perf.diskUsed / perf.diskTotal) * 100 : 0

  return (
    <div className="ssh-panel">
      <div className="ssh-panel__header">
        <span className="ssh-panel__title">
          <Activity size={13} strokeWidth={1.8} />
          性能面板
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="ssh-panel__btn" onClick={fetchPerf} disabled={loading} title="刷新">
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} strokeWidth={2} />}
          </button>
          <button className="ssh-panel__btn" onClick={onClose} title="关闭">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="ssh-panel__body">
        {error && <div className="panel-error">{error}</div>}
        {!perf && !error && (
          <div className="panel-loading"><Loader2 size={24} className="spin" /><span>连接中…</span></div>
        )}

        {perf && (
          <>
            {/* ── 基础信息 ── */}
            <div className="perf-info-grid">
              <div className="perf-info-item">
                <span className="perf-info-key">IP 地址</span>
                <span className="perf-info-val mono">{perf.ip || '—'}</span>
              </div>
              <div className="perf-info-item">
                <span className="perf-info-key">主机名</span>
                <span className="perf-info-val">{perf.hostname || '—'}</span>
              </div>
              <div className="perf-info-item">
                <span className="perf-info-key">系统</span>
                <span className="perf-info-val">{perf.os || '—'}</span>
              </div>
              <div className="perf-info-item">
                <span className="perf-info-key">用户</span>
                <span className="perf-info-val">{perf.username}</span>
              </div>
              <div className="perf-info-item perf-info-item--link" onClick={() => jumpTo('cpu')}>
                <span className="perf-info-key">CPU</span>
                <span className="perf-info-val" style={{ color: cpuColor(perf.cpuTotal) }}>{perf.cpuCount} 核 · {perf.cpuTotal.toFixed(1)}%</span>
              </div>
              <div className="perf-info-item perf-info-item--link" onClick={() => jumpTo('mem')}>
                <span className="perf-info-key">内存</span>
                <span className="perf-info-val">{fmtGB(perf.memTotal)} · {memPct.toFixed(0)}%</span>
              </div>
              <div className="perf-info-item perf-info-item--link" onClick={() => jumpTo('disk')}>
                <span className="perf-info-key">磁盘</span>
                <span className="perf-info-val">{fmtGB(perf.diskUsed)} / {fmtGB(perf.diskTotal)}</span>
              </div>
              <div className="perf-info-item perf-info-item--link" onClick={() => jumpTo('proc')}>
                <span className="perf-info-key">运行</span>
                <span className="perf-info-val">{perf.uptime}</span>
              </div>
            </div>

            {/* ── CPU ── */}
            <div ref={cpuRef}><Section
              icon={<Cpu size={11} strokeWidth={1.8} />}
              title="CPU"
              right={<span style={{ color: cpuColor(perf.cpuTotal), fontSize: 11, fontWeight: 600 }}>{perf.cpuTotal.toFixed(1)}%</span>}
              open={open.cpu}
              onToggle={() => toggle('cpu')}
            >
              <div className="perf-cpu-row" style={{ marginBottom: 4 }}>
                <span className="perf-cpu-label">总使用率</span>
                <Bar pct={perf.cpuTotal} color={cpuColor(perf.cpuTotal)} />
                <span className="perf-core-pct" style={{ color: cpuColor(perf.cpuTotal) }}>
                  {perf.cpuTotal.toFixed(1)}%
                </span>
              </div>
              {perf.cpuCores.map((pct, i) => (
                <div key={i} className="perf-core-row">
                  <span className="perf-core-label">CPU{i + 1}</span>
                  <Bar pct={pct} color={cpuColor(pct)} />
                  <span className="perf-core-pct">{pct.toFixed(1)}%</span>
                </div>
              ))}
            </Section></div>

            {/* ── 内存 ── */}
            <div ref={memRef}><Section
              icon={<HardDrive size={11} strokeWidth={1.8} />}
              title="内存"
              right={<span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{memPct.toFixed(0)}%</span>}
              open={open.mem}
              onToggle={() => toggle('mem')}
            >
              <div className="perf-mem-row">
                <span className="perf-mem-label">物理内存</span>
                <span className="perf-mem-val">{fmt(perf.memUsed)} / {fmt(perf.memTotal)}</span>
              </div>
              <Bar pct={memPct} color="var(--accent)" />
              {perf.swapTotal > 0 && (
                <>
                  <div className="perf-mem-row" style={{ marginTop: 8 }}>
                    <span className="perf-mem-label">Swap</span>
                    <span className="perf-mem-val">{fmt(perf.swapUsed)} / {fmt(perf.swapTotal)}</span>
                  </div>
                  <Bar pct={(perf.swapUsed / perf.swapTotal) * 100} color="var(--warning)" />
                </>
              )}
            </Section></div>

            {/* ── 磁盘 ── */}
            <div ref={diskRef}><Section
              icon={<HardDrive size={11} strokeWidth={1.8} />}
              title={`磁盘 (${perf.disks.length} 个分区)`}
              right={<span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{diskPct.toFixed(0)}%</span>}
              open={open.disk}
              onToggle={() => toggle('disk')}
            >
              {perf.disks.map((d) => {
                const pct = d.total > 0 ? (d.used / d.total) * 100 : 0
                return (
                  <div key={d.mount} style={{ marginBottom: 8 }}>
                    <div className="perf-mem-row">
                      <span className="perf-mem-label mono" style={{ fontSize: 11 }}>{d.mount}</span>
                      <span className="perf-mem-val">{fmt(d.used)} / {fmt(d.total)}</span>
                    </div>
                    <Bar pct={pct} color={pct > 80 ? 'var(--error)' : 'var(--accent)'} />
                  </div>
                )
              })}
            </Section></div>

            {/* ── 网络 ── */}
            <div ref={netRef}><Section
              icon={<Network size={11} strokeWidth={1.8} />}
              title="网络"
              right={<span style={{ color: 'var(--text-muted)', fontSize: 11 }}>↑{fmt(netRate.tx)}/s</span>}
              open={open.net}
              onToggle={() => toggle('net')}
            >
              <div className="perf-net-row">
                <div className="perf-net-item">
                  <span className="perf-net-label">↑ 上行</span>
                  <span className="perf-net-val tx">{fmt(netRate.tx)}/s</span>
                </div>
                <div className="perf-net-item">
                  <span className="perf-net-label">↓ 下行</span>
                  <span className="perf-net-val rx">{fmt(netRate.rx)}/s</span>
                </div>
              </div>
            </Section></div>

            {/* ── 进程 ── */}
            <div ref={procRef}><Section
              icon={<List size={11} strokeWidth={1.8} />}
              title="进程"
              right={<span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{perf.processes.length} 个</span>}
              open={open.proc}
              onToggle={() => toggle('proc')}
            >
              <input
                className="perf-search"
                placeholder="搜索进程…"
                value={processSearch}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setProcessSearch(e.target.value)}
              />
              <div className="perf-proc-list">
                <div className="perf-proc-header">
                  <span style={{ flex: 2 }}>进程</span>
                  <span style={{ width: 44, textAlign: 'right' }}>PID</span>
                  <span style={{ width: 48, textAlign: 'right', color: 'var(--accent)' }}>%CPU</span>
                  <span style={{ width: 52, textAlign: 'right' }}>内存</span>
                  <span style={{ width: 24 }} />
                </div>
                {filteredProcs.map((p) => (
                  <div key={p.pid} className="perf-proc-row">
                    <span className="perf-proc-name" style={{ flex: 2 }} title={p.name}>{p.name}</span>
                    <span style={{ width: 44, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{p.pid}</span>
                    <span style={{ width: 48, textAlign: 'right', color: 'var(--accent)', fontSize: 11 }}>{p.cpuPct.toFixed(1)}%</span>
                    <span style={{ width: 52, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{p.memMb.toFixed(0)}M</span>
                    <span style={{ width: 24, display: 'flex', justifyContent: 'center' }}>
                      {killing === p.pid
                        ? <Loader2 size={11} className="spin" style={{ color: 'var(--text-muted)' }} />
                        : (
                          <button
                            className="proc-kill-btn"
                            title={`强制终止 ${p.name}(${p.pid})`}
                            onClick={(e) => { e.stopPropagation(); killProcess(p.pid, p.name) }}
                          >
                            <XCircle size={12} strokeWidth={1.8} />
                          </button>
                        )
                      }
                    </span>
                  </div>
                ))}
              </div>
            </Section></div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!dialog}
        title={dialog?.title ?? ''}
        desc={dialog?.desc ?? ''}
        danger
        okText="强制终止"
        onOk={() => dialog?.onOk()}
        onCancel={() => setDialog(null)}
      />
    </div>
  )
}
