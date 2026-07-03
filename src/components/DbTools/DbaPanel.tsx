// 跨方言 DBA 面板：会话 / 实例指标 / 空间统计 / Top SQL / 锁与阻塞 / 健康检查
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { X, RefreshCw, Database, Activity, Cpu, HardDrive, BarChart2, AlertTriangle, CheckCircle, Skull, Settings, GitBranch, Server, Archive } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from '../../stores/toastStore'
import { isMysqlFamily } from '../../utils/sqlDialect'
import { clampIntoViewport } from '../../utils/menuClamp'
import type { ConnType } from '../../types'
import { toolsFor } from './dbToolsCatalog'
import { renderAdvancedEmbedded, ADV_EMBEDDED } from './advancedEmbed'
import VariablesPanel from './VariablesPanel'
import TxMonitorPanel from './TxMonitorPanel'
import ReplicationPanel from './ReplicationPanel'
import MgrPanel from './MgrPanel'
import LockHistoryPanel from './LockHistoryPanel'
import PerfSchemaPanel from './PerfSchemaPanel'
import DashboardPanel from './DashboardPanel'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

type DbaTab = 'sessions' | 'metrics' | 'space' | 'topsql' | 'locks' | 'health'
type ToolTab = 'variables' | 'txMonitor' | 'replication' | 'mgr' | 'lockHistory' | 'perfSchema' | 'dashboard'
type Tab = DbaTab | ToolTab

interface DbaResult {
  columns: string[]
  rows: Array<Array<string | null>>
}

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'sessions', label: '会话',    icon: <Activity size={12} /> },
  { key: 'metrics',  label: '实例指标', icon: <Cpu size={12} /> },
  { key: 'space',    label: '空间统计', icon: <HardDrive size={12} /> },
  { key: 'topsql',   label: 'Top SQL', icon: <BarChart2 size={12} /> },
  { key: 'locks',    label: '锁与阻塞', icon: <AlertTriangle size={12} /> },
  { key: 'health',   label: '健康检查', icon: <CheckCircle size={12} /> },
]

// 集成进来的 MySQL 系运维工具（作为额外 tab，内容嵌入渲染）
const TOOL_TABS: { key: ToolTab; label: string; icon: React.ReactNode }[] = [
  { key: 'variables',   label: '变量/状态',  icon: <Settings size={12} /> },
  { key: 'txMonitor',   label: '事务监控',   icon: <GitBranch size={12} /> },
  { key: 'replication', label: '主从复制',   icon: <Activity size={12} /> },
  { key: 'mgr',         label: 'MGR/半同步', icon: <Server size={12} /> },
  { key: 'lockHistory', label: '死锁历史',   icon: <Archive size={12} /> },
  { key: 'perfSchema',  label: 'Perf Schema', icon: <BarChart2 size={12} /> },
  { key: 'dashboard',   label: '实例仪表盘', icon: <Activity size={12} /> },
]
const TOOL_KEYS = new Set<string>(TOOL_TABS.map(t => t.key))
const BASE_KEYS = new Set<string>(TABS.map(t => t.key))

// 健康检查「状态」列着色
const statusColor = (s: string): { fg: string; bg: string } => {
  if (s.includes('警告')) return { fg: '#dc2626', bg: 'rgba(220,38,38,0.1)' }
  if (s.includes('提示')) return { fg: '#ea580c', bg: 'rgba(234,88,12,0.1)' }
  if (s.includes('正常')) return { fg: '#16a34a', bg: 'rgba(22,163,74,0.12)' }
  return { fg: 'var(--accent)', bg: 'var(--accent-bg)' }
}

export default function DbaPanel({ connectionId, connType, onClose }: Props) {
  const [tab, setTab] = useState<string>('sessions')
  const [data, setData] = useState<DbaResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // 运维工具下拉（把 7 个 MySQL 工具 tab 收进一个下拉，避免 tab 栏过长）
  const [toolMenuOpen, setToolMenuOpen] = useState(false)
  const [toolMenuPos, setToolMenuPos] = useState<{ top: number; left: number } | null>(null)
  const toolBtnRef = useRef<HTMLButtonElement>(null)
  const toolMenuRef = useRef<HTMLDivElement | null>(null)
  // 专属工具下拉（各数据库类型的高级/专属工具，已内嵌的才列出）
  const [advMenuOpen, setAdvMenuOpen] = useState(false)
  const [advMenuPos, setAdvMenuPos] = useState<{ top: number; left: number } | null>(null)
  const advBtnRef = useRef<HTMLButtonElement>(null)
  const advMenuRef = useRef<HTMLDivElement | null>(null)
  const hasTools = isMysqlFamily(connType)
  const activeTool = TOOL_TABS.find(t => t.key === tab)
  const advTools = toolsFor('advanced', connType as ConnType).filter(t => ADV_EMBEDDED.has(t.tool))
  const advKeys = new Set(advTools.map(t => t.tool))
  const activeAdv = advTools.find(t => t.tool === tab)
  const runSql = (sql: string) => window.dispatchEvent(new CustomEvent('dbterm:run-sql', { detail: { sql, connId: connectionId } }))

  const fetchData = useCallback(async (t: string) => {
    if (!BASE_KEYS.has(t)) return   // 仅 6 个基础 tab 走 db_dba；工具/专属 tab 由嵌入面板自管
    setLoading(true); setError(null); setMsg(null); setData(null)
    try {
      const r = t === 'health'
        ? await invoke<DbaResult>('db_dba_health', { id: connectionId })
        : await invoke<DbaResult>('db_dba_query', { id: connectionId, kind: t })
      setData(r)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [connectionId])

  useEffect(() => { fetchData(tab) }, [tab, fetchData])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!toolMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (toolBtnRef.current?.contains(t) || toolMenuRef.current?.contains(t)) return
      setToolMenuOpen(false)
    }
    // 用捕获阶段：面板卡片 onMouseDown 会 stopPropagation，冒泡监听收不到，捕获阶段不受影响
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [toolMenuOpen])
  useEffect(() => {
    if (!advMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (advBtnRef.current?.contains(t) || advMenuRef.current?.contains(t)) return
      setAdvMenuOpen(false)
    }
    // 用捕获阶段：面板卡片 onMouseDown 会 stopPropagation，冒泡监听收不到，捕获阶段不受影响
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [advMenuOpen])

  const killSession = async (sid: string) => {
    if (!window.confirm(`确认终止会话 ${sid}？该连接正在执行的语句会被中断。`)) return
    try {
      const r = await invoke<string>('db_dba_kill_session', { id: connectionId, sessionId: sid })
      setMsg(r); setError(null)
      fetchData('sessions')
    } catch (e) { toast.error(`终止失败：${e}`) }
  }

  const statusIdx = data ? data.columns.indexOf('状态') : -1
  const isHealth = tab === 'health'

  // 健康检查：数值可下钻到对应 DBA tab
  const HEALTH_DRILL: Record<string, string> = {
    // 会话相关
    '中断连接(Aborted_connects)': 'sessions',
    '连接使用率': 'sessions',
    '空闲事务(idle in transaction)': 'sessions',
    '用户连接数': 'sessions',       // SQL Server
    // 性能 / Top SQL
    '慢查询(Slow_queries)': 'topsql',
    '磁盘临时表(Created_tmp_disk_tables)': 'topsql',
    '当前查询': 'topsql',           // ClickHouse
    // 指标
    'InnoDB 缓冲池命中率': 'metrics',
    '缓存命中率': 'metrics',        // PG
    '内存追踪': 'metrics',          // ClickHouse
    // 锁 / 阻塞
    '等待表锁(Table_locks_waited)': 'locks',
    '未授予锁(阻塞)': 'locks',
    '累计死锁': 'locks',
    '阻塞请求': 'locks',            // SQL Server
    // 存储空间
    '空闲页比例': 'space',          // SQLite
  }

  const panel = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: '92vw', maxWidth: 1100, height: '84vh', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'slideUp .18s ease' }}>
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>DBA 面板</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{connType}</span>
          <button onClick={() => fetchData(tab)}
            style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} /> 刷新
          </button>
          <button onClick={onClose} style={{ padding: 4, color: 'var(--text-muted)', cursor: 'pointer' }}><X size={16} /></button>
        </div>

        {/* Tab 栏：6 核心 tab + 运维工具下拉（MySQL 系），避免 13 个 tab 横排过长 */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, padding: '8px 12px 0', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 12, cursor: 'pointer',
                border: '1px solid ' + (tab === t.key ? 'var(--border)' : 'transparent'),
                borderBottom: tab === t.key ? '1px solid var(--surface)' : '1px solid transparent',
                background: tab === t.key ? 'var(--surface)' : 'transparent',
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)', whiteSpace: 'nowrap', marginBottom: -1 }}>
              {t.icon} {t.label}
            </button>
          ))}
          {hasTools && (
            <button ref={toolBtnRef}
              onClick={() => {
                const r = toolBtnRef.current!.getBoundingClientRect()
                setToolMenuPos({ top: r.bottom + 2, left: r.left })
                setAdvMenuOpen(false)
                setToolMenuOpen(o => !o)
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
                border: '1px solid ' + (activeTool ? 'var(--border)' : 'transparent'),
                borderBottom: activeTool ? '1px solid var(--surface)' : '1px solid transparent',
                background: activeTool ? 'var(--surface)' : 'transparent',
                color: activeTool ? 'var(--accent)' : 'var(--text-muted)' }}>
              {activeTool ? <>{activeTool.icon} {activeTool.label}</> : <>运维工具</>}
              <ChevronDown size={12} />
            </button>
          )}
          {advTools.length > 0 && (
            <button ref={advBtnRef}
              onClick={() => {
                const r = advBtnRef.current!.getBoundingClientRect()
                setAdvMenuPos({ top: r.bottom + 2, left: r.left })
                setToolMenuOpen(false)
                setAdvMenuOpen(o => !o)
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
                border: '1px solid ' + (activeAdv ? 'var(--border)' : 'transparent'),
                borderBottom: activeAdv ? '1px solid var(--surface)' : '1px solid transparent',
                background: activeAdv ? 'var(--surface)' : 'transparent',
                color: activeAdv ? 'var(--accent)' : 'var(--text-muted)' }}>
              {activeAdv ? <>{activeAdv.icon} {activeAdv.label}</> : <>专属工具</>}
              <ChevronDown size={12} />
            </button>
          )}
        </div>

        {/* 内容区：MySQL 工具 / 专属工具 tab 渲染嵌入面板，基础 tab 渲染 db_dba 结果 */}
        {TOOL_KEYS.has(tab) ? (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {tab === 'variables'   && <VariablesPanel  embedded connectionId={connectionId} connType={connType} onClose={onClose} />}
            {tab === 'txMonitor'   && <TxMonitorPanel  embedded connectionId={connectionId} connType={connType} onClose={onClose} />}
            {tab === 'replication' && <ReplicationPanel embedded connectionId={connectionId} connType={connType} onClose={onClose} />}
            {tab === 'mgr'         && <MgrPanel        embedded connectionId={connectionId} connType={connType} onClose={onClose} />}
            {tab === 'lockHistory' && <LockHistoryPanel embedded connectionId={connectionId} connType={connType} onClose={onClose} />}
            {tab === 'perfSchema'  && <PerfSchemaPanel embedded connectionId={connectionId} connType={connType} schema="" onClose={onClose} />}
            {tab === 'dashboard'   && <DashboardPanel  embedded connId={connectionId} connName={connType} connType={connType} onClose={onClose} />}
          </div>
        ) : advKeys.has(tab) ? (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {renderAdvancedEmbedded(tab, { connectionId, connType, schema: '', onClose, onRunSql: runSql })}
          </div>
        ) : (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px 14px' }}>
          {msg && <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, background: '#16a34a20', border: '1px solid #16a34a40', color: '#16a34a', fontSize: 12, flexShrink: 0 }}>{msg}</div>}
          {error && <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, background: '#dc262620', border: '1px solid #dc262640', color: '#dc2626', fontSize: 12, flexShrink: 0 }}>{error}</div>}

          {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>加载中…</div>}

          {!loading && data && data.columns.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    {data.columns.map((c, i) => (
                      <th key={i} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{c}</th>
                    ))}
                    {tab === 'sessions' && <th style={{ padding: '6px 10px', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, ri) => (
                    <tr key={ri}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      {row.map((cell, ci) => {
                        if (isHealth && ci === statusIdx) {
                          const c = statusColor(cell ?? '')
                          return <td key={ci} style={{ padding: '5px 10px', border: '1px solid var(--border-subtle)' }}>
                            <span style={{ fontSize: 11, color: c.fg, background: c.bg, borderRadius: 4, padding: '1px 8px' }}>{cell}</span>
                          </td>
                        }
                        // 健康检查「详情」列：有对应 DBA tab 时，数字本身即可点击下钻（去掉单独按钮）
                        if (isHealth && ci === 3) {
                          const drillTab = HEALTH_DRILL[row[1] ?? '']
                          return <td key={ci} style={{ padding: '5px 10px', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                            {drillTab ? (
                              <span
                                onClick={() => setTab(drillTab)}
                                style={{ color: 'var(--accent)', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                              >
                                {cell}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text)' }}>{cell}</span>
                            )}
                          </td>
                        }
                        return <td key={ci} style={{ padding: '5px 10px', color: 'var(--text)', border: '1px solid var(--border-subtle)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-tip={cell ?? ''}>
                          {cell ?? <span style={{ color: 'var(--text-muted)' }}>NULL</span>}
                        </td>
                      })}
                      {tab === 'sessions' && (
                        <td style={{ padding: '4px 10px', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                          <button onClick={() => killSession(row[0] ?? '')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer', background: '#dc262620', color: '#dc2626', border: '1px solid #dc262640' }}>
                            <Skull size={11} /> 终止
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>共 {data.rows.length} 条</div>
            </div>
          )}

          {!loading && data && data.rows.length === 0 && !error && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>
              {tab === 'locks' ? '当前无锁等待 / 阻塞' : tab === 'sessions' ? '暂无活动会话' : '暂无数据'}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )

  return createPortal(
    <>
      {panel}
      {toolMenuOpen && toolMenuPos && (
        <div ref={(el) => { toolMenuRef.current = el; clampIntoViewport(el) }} style={{
          position: 'fixed', top: toolMenuPos.top, left: toolMenuPos.left, zIndex: 10000,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)', overflowY: 'auto', minWidth: 180, maxHeight: '60vh', padding: '4px 0',
        }}>
          {TOOL_TABS.map(t => (
            <button key={t.key}
              onClick={() => { setTab(t.key); setToolMenuOpen(false) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', fontSize: 12, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap',
                color: tab === t.key ? 'var(--accent)' : 'var(--text)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {advMenuOpen && advMenuPos && (
        <div ref={(el) => { advMenuRef.current = el; clampIntoViewport(el) }} style={{
          position: 'fixed', top: advMenuPos.top, left: advMenuPos.left, zIndex: 10000,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)', overflowY: 'auto', minWidth: 180, maxHeight: '60vh', padding: '4px 0',
        }}>
          {advTools.map(t => (
            <button key={t.tool}
              onClick={() => { setTab(t.tool); setAdvMenuOpen(false) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', fontSize: 12, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap',
                color: tab === t.tool ? 'var(--accent)' : 'var(--text)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body,
  )
}
