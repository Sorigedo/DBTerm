// R8 DBA 管理面板：巡检报告 / 配置风险 / 告警阈值 / ACL / 定时任务 / 命令片段库
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  ClipboardList, AlertTriangle, Bell, Lock, Clock, BookOpen,
  RefreshCw, Download, Play, Plus, Trash2, Loader2, Check, X, ChevronDown, ChevronRight,
  Network, Shield, Copy, CheckCircle,
} from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'
import SearchableSelect from '../DbTools/SearchableSelect'
import { toast } from '../../stores/toastStore'
import { queueLocalTextExport } from '../../utils/exportTasks'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    queueLocalTextExport(path, content, label)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface Props {
  connectionId: string
  db: number
  caps: number
}

// ── R8.1 巡检报告 ─────────────────────────────────────────────────────────────

interface InspectItem {
  category: string; name: string; status: 'ok' | 'warn' | 'error'
  value: string; suggestion: string
}
interface InspectReport {
  items: InspectItem[]; score: number; version: string; role: string
  uptimeSecs: number; usedMemoryHuman: string; maxMemoryHuman: string
  totalKeys: number; markdown: string
}

// ── R8.2 配置风险 ─────────────────────────────────────────────────────────────

interface ConfigRisk {
  key: string; currentValue: string; riskLevel: 'warn' | 'error'
  description: string; suggestion: string
}

// ── R8.4 ACL ─────────────────────────────────────────────────────────────────

interface AclUser {
  username: string; flags: string[]; passwords: string[]
  commands: string; keys: string; channels: string; selectors: string[]
}

// ── R8.3 告警阈值（纯前端，localStorage 存储）────────────────────────────────

const ALERT_KEY = (id: string) => `redis-alert-cfg-${id}`

interface AlertConfig {
  memPct: number    // 内存使用率 %
  hitRate: number   // 命中率低于此值告警（%）
  replLagBytes: number // 复制延迟（字节）
  enabled: boolean
}

function loadAlertCfg(id: string): AlertConfig {
  try { return JSON.parse(localStorage.getItem(ALERT_KEY(id)) ?? '') } catch {
    return { memPct: 85, hitRate: 80, replLagBytes: 1048576, enabled: false }
  }
}

// ── R8.5 定时任务（Redis 专属，localStorage 存储）────────────────────────────

const SCHED_KEY = (id: string) => `redis-scheduler-${id}`

interface RedisTask {
  id: string; name: string; type: 'bgsave' | 'inspect'
  intervalMinutes: number; enabled: boolean
  lastRun?: number; lastStatus?: 'ok' | 'error'; lastMessage?: string
}

function loadTasks(id: string): RedisTask[] {
  try { return JSON.parse(localStorage.getItem(SCHED_KEY(id)) ?? '[]') } catch { return [] }
}
function saveTasks(id: string, tasks: RedisTask[]) {
  localStorage.setItem(SCHED_KEY(id), JSON.stringify(tasks))
}

// ── R8.6 命令片段库（localStorage 存储）─────────────────────────────────────

const SNIPPET_KEY = 'redis-snippets'

interface RedisSnippet {
  id: string; name: string; command: string; description?: string
}

function loadSnippets(): RedisSnippet[] {
  try { return JSON.parse(localStorage.getItem(SNIPPET_KEY) ?? '[]') } catch { return [] }
}
function saveSnippets(snips: RedisSnippet[]) {
  localStorage.setItem(SNIPPET_KEY, JSON.stringify(snips))
}

// ─────────────────────────────────────────────────────────────────────────────

type DbaTab = 'inspect' | 'risks' | 'alerts' | 'acl' | 'scheduler' | 'snippets' | 'sentinel' | 'cluster' | 'recovery'

export default function DbaPanel({ connectionId, db, caps }: Props) {
  const [tab, setTab] = useState<DbaTab>('inspect')

  // ── R8.1 巡检 ─────────────────────────────────────────────────────────────
  const [report, setReport] = useState<InspectReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')

  const loadReport = useCallback(async () => {
    setReportLoading(true); setReportError('')
    try {
      const r = await invoke<InspectReport>('redis_inspect_report', { id: connectionId, db })
      setReport(r)
    } catch (e) { setReportError(String(e)) }
    finally { setReportLoading(false) }
  }, [connectionId, db])

  // ── R8.2 配置风险 ─────────────────────────────────────────────────────────
  const [risks, setRisks] = useState<ConfigRisk[] | null>(null)
  const [risksLoading, setRisksLoading] = useState(false)
  const [risksError, setRisksError] = useState('')

  const loadRisks = useCallback(async () => {
    setRisksLoading(true); setRisksError('')
    try {
      const r = await invoke<ConfigRisk[]>('redis_config_risks', { id: connectionId, db })
      setRisks(r)
    } catch (e) { setRisksError(String(e)) }
    finally { setRisksLoading(false) }
  }, [connectionId, db])

  // ── R8.3 告警 ─────────────────────────────────────────────────────────────
  const [alertCfg, setAlertCfg] = useState<AlertConfig>(() => loadAlertCfg(connectionId))
  const [alertEditing, setAlertEditing] = useState(false)
  const [alertDraft, setAlertDraft] = useState<AlertConfig>(alertCfg)
  const [activeAlerts, setActiveAlerts] = useState<string[]>([])
  const alertTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const saveAlertCfg = (cfg: AlertConfig) => {
    localStorage.setItem(ALERT_KEY(connectionId), JSON.stringify(cfg))
    setAlertCfg(cfg)
  }

  const checkAlerts = useCallback(async (cfg: AlertConfig) => {
    if (!cfg.enabled) { setActiveAlerts([]); return }
    try {
      const stats = await invoke<{
        usedMemoryBytes: number; maxMemoryBytes: number
        keyspaceHits: number; keyspaceMisses: number
        masterReplOffset: number
      }>('redis_info_stats', { id: connectionId, db })

      const triggered: string[] = []
      if (stats.maxMemoryBytes > 0) {
        const pct = stats.usedMemoryBytes / stats.maxMemoryBytes * 100
        if (pct >= cfg.memPct) triggered.push(`内存使用率 ${pct.toFixed(1)}% ≥ 阈值 ${cfg.memPct}%`)
      }
      const total = stats.keyspaceHits + stats.keyspaceMisses
      if (total > 0) {
        const hr = stats.keyspaceHits / total * 100
        if (hr < cfg.hitRate) triggered.push(`命中率 ${hr.toFixed(1)}% < 阈值 ${cfg.hitRate}%`)
      }
      setActiveAlerts(triggered)
    } catch (_) {}
  }, [connectionId, db])

  useEffect(() => {
    if (alertCfg.enabled) {
      checkAlerts(alertCfg)
      alertTimerRef.current = setInterval(() => checkAlerts(alertCfg), 30_000)
    } else {
      if (alertTimerRef.current) { clearInterval(alertTimerRef.current); alertTimerRef.current = null }
      setActiveAlerts([])
    }
    return () => { if (alertTimerRef.current) clearInterval(alertTimerRef.current) }
  }, [alertCfg, checkAlerts])

  // ── R8.4 ACL ─────────────────────────────────────────────────────────────
  const [aclUsers, setAclUsers] = useState<AclUser[] | null>(null)
  const [aclWhoami, setAclWhoami] = useState('')
  const [aclLoading, setAclLoading] = useState(false)
  const [aclError, setAclError] = useState('')
  const [aclCats, setAclCats] = useState<string[]>([])
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const [confirmDelUser, setConfirmDelUser] = useState<string | null>(null)
  const [newUserDlg, setNewUserDlg] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newUserRules, setNewUserRules] = useState('on nopass ~* +@all')
  const [aclSaving, setAclSaving] = useState(false)

  const loadAcl = useCallback(async () => {
    if (!(caps & 0x4)) { setAclError('当前 Redis 版本不支持 ACL（需 6.0+）'); return }
    setAclLoading(true); setAclError('')
    try {
      const [users, whoami, cats] = await Promise.all([
        invoke<AclUser[]>('redis_acl_list', { id: connectionId, db }),
        invoke<string>('redis_acl_whoami', { id: connectionId, db }),
        invoke<string[]>('redis_acl_cat', { id: connectionId, db }),
      ])
      setAclUsers(users); setAclWhoami(whoami); setAclCats(cats)
    } catch (e) { setAclError(String(e)) }
    finally { setAclLoading(false) }
  }, [connectionId, db, caps])

  const doDelUser = async (username: string) => {
    try {
      await invoke('redis_acl_deluser', { id: connectionId, username, db })
      await loadAcl()
    } catch (e) { setAclError(String(e)) }
    finally { setConfirmDelUser(null) }
  }

  const doAddUser = async () => {
    const rules = newUserRules.trim().split(/\s+/).filter(Boolean)
    setAclSaving(true)
    try {
      await invoke('redis_acl_setuser', { id: connectionId, username: newUsername.trim(), rules, db })
      setNewUserDlg(false); setNewUsername(''); setNewUserRules('on nopass ~* +@all')
      await loadAcl()
    } catch (e) { setAclError(String(e)) }
    finally { setAclSaving(false) }
  }

  // ── R8.5 定时任务 ─────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<RedisTask[]>(() => loadTasks(connectionId))
  const [taskFormOpen, setTaskFormOpen] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskType, setTaskType] = useState<'bgsave' | 'inspect'>('bgsave')
  const [taskInterval, setTaskInterval] = useState(60)
  const taskTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  // 始终指向最新 tasks：定时器回调据此读/写，避免陈旧闭包用旧快照覆盖期间的编辑
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const persistTasks = (t: RedisTask[]) => { saveTasks(connectionId, t); setTasks(t) }

  const addTask = () => {
    const t: RedisTask = {
      id: `rt_${Date.now()}`,
      name: taskName.trim() || (taskType === 'bgsave' ? '定时 BGSAVE' : '定时巡检'),
      type: taskType, intervalMinutes: taskInterval, enabled: true,
    }
    persistTasks([...tasks, t])
    setTaskFormOpen(false); setTaskName('')
  }

  const toggleTask = (id: string) => {
    persistTasks(tasks.map(t => t.id === id ? { ...t, enabled: !t.enabled } : t))
  }
  const removeTask = (id: string) => {
    const timer = taskTimersRef.current.get(id)
    if (timer) { clearInterval(timer); taskTimersRef.current.delete(id) }
    persistTasks(tasks.filter(t => t.id !== id))
  }

  const runTask = useCallback(async (task: RedisTask) => {
    try {
      if (task.type === 'bgsave') {
        await invoke('redis_bgsave', { id: connectionId, db })
      } else {
        await invoke('redis_inspect_report', { id: connectionId, db })
      }
      persistTasks(tasksRef.current.map(t => t.id === task.id
        ? { ...t, lastRun: Date.now(), lastStatus: 'ok', lastMessage: '执行成功' } : t))
    } catch (e) {
      persistTasks(tasksRef.current.map(t => t.id === task.id
        ? { ...t, lastRun: Date.now(), lastStatus: 'error', lastMessage: String(e) } : t))
    }
  // 用 tasksRef 读最新快照 → 回调可稳定（不依赖 tasks），避免覆盖期间编辑
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, db])

  // 定时器管理
  useEffect(() => {
    // intervalMinutes 变化也要重建定时器（下方依赖签名已含），先清空再按当前启用项重建
    taskTimersRef.current.forEach(t => clearInterval(t))
    taskTimersRef.current.clear()
    tasks.forEach(task => {
      if (!task.enabled || task.intervalMinutes <= 0) return
      // 触发时按 id 取最新任务（避免捕获旧 task 快照），仍启用才执行
      const timer = setInterval(() => {
        const cur = tasksRef.current.find(t => t.id === task.id)
        if (cur?.enabled) runTask(cur)
      }, task.intervalMinutes * 60_000)
      taskTimersRef.current.set(task.id, timer)
    })
    return () => {
      taskTimersRef.current.forEach(t => clearInterval(t))
      taskTimersRef.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.map(t => `${t.id}:${t.enabled}:${t.intervalMinutes}`).join(','), runTask])

  // ── R8.6 命令片段库 ───────────────────────────────────────────────────────
  const [snippets, setSnippets] = useState<RedisSnippet[]>(loadSnippets)
  const [snipFormOpen, setSnipFormOpen] = useState(false)
  const [snipName, setSnipName] = useState('')
  const [snipCmd, setSnipCmd] = useState('')
  const [snipDesc, setSnipDesc] = useState('')
  const [snipResult, setSnipResult] = useState<Record<string, string>>({})
  const [snipRunning, setSnipRunning] = useState<string | null>(null)

  const persistSnippets = (s: RedisSnippet[]) => { saveSnippets(s); setSnippets(s) }

  const addSnippet = () => {
    const s: RedisSnippet = {
      id: `snip_${Date.now()}`,
      name: snipName.trim(), command: snipCmd.trim(), description: snipDesc.trim(),
    }
    persistSnippets([...snippets, s])
    setSnipFormOpen(false); setSnipName(''); setSnipCmd(''); setSnipDesc('')
  }
  const removeSnippet = (id: string) => persistSnippets(snippets.filter(s => s.id !== id))
  const runSnippet = async (snip: RedisSnippet) => {
    setSnipRunning(snip.id)
    try {
      const r = await invoke<{ output: string; ok: boolean }>('redis_cli_exec', {
        id: connectionId, command: snip.command, db, confirmed: false,
      })
      setSnipResult(prev => ({ ...prev, [snip.id]: r.output }))
    } catch (e) { setSnipResult(prev => ({ ...prev, [snip.id]: String(e) })) }
    finally { setSnipRunning(null) }
  }

  // ── 初始加载 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab === 'inspect') loadReport()
    if (tab === 'risks') loadRisks()
    if (tab === 'acl') loadAcl()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  const exportMarkdown = async () => {
    if (!report) return
    await saveTextFile(report.markdown, `redis-inspect-${Date.now()}.md`, 'Markdown 文件', 'md')
  }

  const fmtTime = (ts?: number) => ts ? new Date(ts).toLocaleTimeString() : '—'

  // R9.2 Sentinel
  const [sentinelLoading, setSentinelLoading] = useState(false)
  const [sentinelError, setSentinelError] = useState('')
  const [isSentinel, setIsSentinel] = useState<boolean | null>(null)
  interface SentinelMaster { name: string; ip: string; port: string; status: string; slaves: string; sentinels: string; flags: string }
  const [sentinelMasters, setSentinelMasters] = useState<SentinelMaster[]>([])

  const loadSentinel = async () => {
    setSentinelLoading(true); setSentinelError('')
    try {
      const res = await invoke<{ output: string; ok: boolean }>('redis_cli_exec', { id: connectionId, command: 'SENTINEL MASTERS', db: 0, confirmed: false })
      if (!res.ok || res.output.includes('ERR unknown command') || res.output.includes('not a sentinel')) {
        setIsSentinel(false); setSentinelLoading(false); return
      }
      setIsSentinel(true)
      // 解析 SENTINEL MASTERS 响应（每个 master 是 key-value 对的数组）
      const parsed = parseSentinelList(res.output)
      setSentinelMasters(parsed)
    } catch (e) { setSentinelError(String(e)) } finally { setSentinelLoading(false) }
  }

  function parseSentinelList(raw: string): SentinelMaster[] {
    // 简单解析：从 RESP 文本中提取 key-value
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
    const masters: SentinelMaster[] = []
    let cur: Record<string, string> = {}
    let isKey = true
    let lastKey = ''
    for (const line of lines) {
      if (line.startsWith('*') || line.startsWith(':')) continue
      if (line.startsWith('$')) { isKey = !lastKey; continue }
      if (isKey || !lastKey) { lastKey = line; isKey = false }
      else { cur[lastKey] = line; lastKey = ''; isKey = true }
      if (Object.keys(cur).length >= 16) {
        masters.push({
          name:      cur['name'] ?? '',
          ip:        cur['ip'] ?? '',
          port:      cur['port'] ?? '',
          status:    cur['status'] ?? '',
          slaves:    cur['num-slaves'] ?? '0',
          sentinels: cur['num-other-sentinels'] ?? '0',
          flags:     cur['flags'] ?? '',
        })
        cur = {}
      }
    }
    return masters
  }

  // R9.1 Cluster
  const [clusterLoading, setClusterLoading] = useState(false)
  const [clusterError, setClusterError] = useState('')
  const [isCluster, setIsCluster] = useState<boolean | null>(null)
  interface ClusterNode { id: string; addr: string; role: string; slots: string; flags: string; masterRef: string }
  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([])
  const [clusterInfo, setClusterInfo] = useState<Record<string, string>>({})

  const loadCluster = async () => {
    setClusterLoading(true); setClusterError('')
    try {
      const infoRes = await invoke<{ output: string; ok: boolean }>('redis_cli_exec', { id: connectionId, command: 'CLUSTER INFO', db: 0, confirmed: false })
      const info = infoRes.output
      const infoMap: Record<string, string> = {}
      for (const line of info.split('\n')) {
        const [k, v] = line.split(':')
        if (k && v) infoMap[k.trim()] = v.trim()
      }
      setClusterInfo(infoMap)
      const enabled = infoMap['cluster_enabled'] === '1'
      setIsCluster(enabled)
      if (!enabled) { setClusterLoading(false); return }

      const nodesRes = await invoke<{ output: string; ok: boolean }>('redis_cli_exec', { id: connectionId, command: 'CLUSTER NODES', db: 0, confirmed: false })
      const nodes = nodesRes.output
      const parsed: ClusterNode[] = nodes.split('\n').filter(Boolean).map(line => {
        const parts = line.split(' ')
        return {
          id:       (parts[0] ?? '').slice(0, 8),
          addr:     parts[1]?.split('@')[0] ?? '',
          flags:    parts[2] ?? '',
          masterRef: parts[3] === '-' ? '' : (parts[3] ?? '').slice(0, 8),
          role:     (parts[2] ?? '').includes('master') ? 'master' : 'slave',
          slots:    parts.slice(8).join(' ') || '—',
        }
      })
      setClusterNodes(parsed)
    } catch (e) { setClusterError(String(e)) } finally { setClusterLoading(false) }
  }

  // R9.3 Recovery copy state
  const [recoveryCopied, setRecoveryCopied] = useState('')
  const copyCmd = (s: string) => {
    navigator.clipboard.writeText(s)
    setRecoveryCopied(s)
    setTimeout(() => setRecoveryCopied(''), 1500)
  }

  useEffect(() => {
    if (tab === 'sentinel') loadSentinel()
    if (tab === 'cluster') loadCluster()
  }, [tab]) // eslint-disable-line

  const TAB_CONFIG: { key: DbaTab; label: string; icon: React.ReactNode }[] = [
    { key: 'inspect',   label: '巡检报告',   icon: <ClipboardList size={12} /> },
    { key: 'risks',     label: '配置风险',   icon: <AlertTriangle size={12} /> },
    { key: 'alerts',    label: '告警阈值',   icon: <Bell size={12} /> },
    { key: 'acl',       label: 'ACL 用户',   icon: <Lock size={12} /> },
    { key: 'scheduler', label: '定时任务',   icon: <Clock size={12} /> },
    { key: 'snippets',  label: '命令片段库', icon: <BookOpen size={12} /> },
    { key: 'sentinel',  label: 'Sentinel',   icon: <Shield size={12} /> },
    { key: 'cluster',   label: '集群(Cluster)', icon: <Network size={12} /> },
    { key: 'recovery',  label: '误删恢复',   icon: <BookOpen size={12} /> },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* 活跃告警横幅 */}
      {activeAlerts.length > 0 && (
        <div style={{ background: 'var(--error)', color: '#fff', padding: '4px 12px', fontSize: 11, flexShrink: 0 }}>
          ⚠ {activeAlerts.join('  |  ')}
        </div>
      )}

      {/* 标签栏 */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto', background: 'var(--surface)' }}>
        {TAB_CONFIG.map(t => (
          <button key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
              fontSize: 12, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
              background: tab === t.key ? 'var(--surface-2)' : 'transparent',
              color: tab === t.key ? 'var(--text-bright)' : 'var(--text-muted)',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >{t.icon}{t.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>

        {/* ══ R8.1 巡检报告 ══════════════════════════════════════════════════ */}
        {tab === 'inspect' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>一键巡检报告</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {report && (
                  <button className="cdlg-btn cdlg-btn--cancel" onClick={exportMarkdown} title="导出 Markdown">
                    <Download size={12} /> 导出
                  </button>
                )}
                <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                  onClick={loadReport} disabled={reportLoading}>
                  {reportLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                  {reportLoading ? '检测中…' : '开始检测'}
                </button>
              </div>
            </div>

            {reportError && <div className="redis-error">{reportError}</div>}

            {report && <>
              {/* 评分卡 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
                {[
                  { label: '综合评分', value: `${report.score}/100`, alert: report.score < 70 },
                  { label: '版本',     value: report.version },
                  { label: '角色',     value: report.role },
                  { label: '内存',     value: `${report.usedMemoryHuman} / ${report.maxMemoryHuman || '无限制'}` },
                ].map(c => (
                  <div key={c.label} style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
                    padding: '8px 12px', textAlign: 'center',
                    ...(c.alert ? { borderColor: '#dc2626' } : {}),
                  }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: c.alert ? '#dc2626' : 'var(--accent)' }}>{c.value}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.label}</div>
                  </div>
                ))}
              </div>

              {/* 进度条 */}
              <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, marginBottom: 16, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4, transition: 'width 0.5s',
                  width: `${report.score}%`,
                  background: report.score >= 80 ? '#16a34a' : report.score >= 60 ? '#ea580c' : '#dc2626',
                }} />
              </div>

              {/* 检查项表格 */}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '4px 6px', textAlign: 'left', width: 70 }}>分类</th>
                    <th style={{ padding: '4px 6px', textAlign: 'left', width: 100 }}>检查项</th>
                    <th style={{ padding: '4px 6px', textAlign: 'center', width: 40 }}>状态</th>
                    <th style={{ padding: '4px 6px', textAlign: 'left' }}>当前值</th>
                    <th style={{ padding: '4px 6px', textAlign: 'left' }}>建议</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '5px 6px', color: 'var(--text-muted)' }}>{item.category}</td>
                      <td style={{ padding: '5px 6px' }}>{item.name}</td>
                      <td style={{ padding: '5px 6px', textAlign: 'center' }}>
                        {item.status === 'ok'
                          ? <Check size={12} style={{ color: 'var(--success)' }} />
                          : item.status === 'warn'
                          ? <AlertTriangle size={12} style={{ color: 'var(--warning)' }} />
                          : <X size={12} style={{ color: 'var(--error)' }} />
                        }
                      </td>
                      <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>{item.value}</td>
                      <td style={{ padding: '5px 6px', color: item.suggestion ? '#ea580c' : 'var(--text-muted)', fontSize: 11 }}>{item.suggestion || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>}
          </div>
        )}

        {/* ══ R8.2 配置风险 ══════════════════════════════════════════════════ */}
        {tab === 'risks' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>配置风险扫描</span>
              <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={loadRisks} disabled={risksLoading}>
                {risksLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                {risksLoading ? '扫描中…' : '扫描'}
              </button>
            </div>

            {risksError && <div className="redis-error">{risksError}</div>}

            {risks && (
              risks.length === 0
                ? <div style={{ color: 'var(--success)', fontSize: 13, padding: 12 }}>✅ 未发现配置风险项</div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {risks.map((risk, i) => (
                      <div key={i} style={{
                        background: 'var(--surface-2)', border: `1px solid ${risk.riskLevel === 'error' ? '#dc2626' : '#ea580c'}`,
                        borderRadius: 8, padding: '10px 14px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <AlertTriangle size={13} style={{ color: risk.riskLevel === 'error' ? '#dc2626' : '#ea580c', flexShrink: 0 }} />
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{risk.key}</span>
                          <span style={{ fontSize: 11, color: risk.riskLevel === 'error' ? '#dc2626' : '#ea580c' }}>
                            {risk.riskLevel === 'error' ? '高风险' : '中风险'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 4 }}>{risk.description}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
                          当前值: {risk.currentValue}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--warning)' }}>💡 {risk.suggestion}</div>
                      </div>
                    ))}
                  </div>
            )}
          </div>
        )}

        {/* ══ R8.3 告警阈值 ══════════════════════════════════════════════════ */}
        {tab === 'alerts' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>告警阈值（本地轮询）</span>
              {alertEditing
                ? <div style={{ display: 'flex', gap: 6 }}>
                    <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setAlertEditing(false)}>取消</button>
                    <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                      onClick={() => { saveAlertCfg(alertDraft); setAlertEditing(false) }}>
                      <Check size={12} /> 保存
                    </button>
                  </div>
                : <button className="cdlg-btn cdlg-btn--cancel" onClick={() => { setAlertDraft(alertCfg); setAlertEditing(true) }}>
                    编辑阈值
                  </button>
              }
            </div>

            {/* 当前告警 */}
            {activeAlerts.length > 0 && (
              <div style={{ marginBottom: 12, padding: 10, background: '#dc262615', border: '1px solid #dc2626', borderRadius: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--error)', marginBottom: 4 }}>当前告警</div>
                {activeAlerts.map((a, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--error)' }}>• {a}</div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 启用开关 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: alertEditing ? 'pointer' : 'default' }}>
                <input type="checkbox"
                  checked={alertEditing ? alertDraft.enabled : alertCfg.enabled}
                  disabled={!alertEditing}
                  onChange={e => setAlertDraft(prev => ({ ...prev, enabled: e.target.checked }))}
                />
                <span style={{ fontSize: 12 }}>启用告警轮询（每 30s 检测一次）</span>
              </label>

              {[
                { label: '内存使用率告警（%）', key: 'memPct' as const, unit: '%', min: 50, max: 100, step: 5 },
                { label: '命中率低于（%）告警', key: 'hitRate' as const, unit: '%', min: 10, max: 99, step: 5 },
                { label: '复制延迟告警（字节）', key: 'replLagBytes' as const, unit: 'B', min: 0, max: 104857600, step: 102400 },
              ].map(field => (
                <div key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--text)', width: 180, flexShrink: 0 }}>{field.label}</span>
                  <input
                    type="number" min={field.min} max={field.max} step={field.step}
                    value={alertEditing ? alertDraft[field.key] : alertCfg[field.key]}
                    disabled={!alertEditing}
                    onChange={e => setAlertDraft(prev => ({ ...prev, [field.key]: +e.target.value }))}
                    style={{
                      width: 90, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px',
                      fontSize: 12, background: alertEditing ? 'var(--surface-2)' : 'var(--bg)', color: 'var(--text)',
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{field.unit}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ R8.4 ACL 用户管理 ══════════════════════════════════════════════ */}
        {tab === 'acl' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>ACL 用户管理</span>
                {aclWhoami && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>当前用户: <b>{aclWhoami}</b></span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="cdlg-btn cdlg-btn--cancel" onClick={loadAcl} disabled={aclLoading} title="刷新">
                  {aclLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                </button>
                <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                  onClick={() => setNewUserDlg(true)} title="新建用户">
                  <Plus size={12} /> 新建
                </button>
              </div>
            </div>

            {aclError && <div className="redis-error">{aclError}</div>}

            {aclUsers && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {aclUsers.map(user => (
                  <div key={user.username} style={{
                    border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--surface-2)', overflow: 'hidden',
                  }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer' }}
                      onClick={() => setExpandedUser(prev => prev === user.username ? null : user.username)}
                    >
                      {expandedUser === user.username ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>{user.username}</span>
                      <span style={{
                        fontSize: 10, padding: '1px 5px', borderRadius: 4,
                        background: user.flags.includes('on') ? '#16a34a20' : '#dc262620',
                        color: user.flags.includes('on') ? '#16a34a' : '#dc2626',
                      }}>{user.flags.includes('on') ? 'active' : 'disabled'}</span>
                      {user.flags.includes('nopass') && (
                        <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#ea580c20', color: 'var(--warning)' }}>nopass</span>
                      )}
                      {user.username !== 'default' && (
                        <button className="cmd-act-btn danger" style={{ marginLeft: 'auto' }}
                          onClick={e => { e.stopPropagation(); setConfirmDelUser(user.username) }}
                          title="删除用户">
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                    {expandedUser === user.username && (
                      <div style={{ padding: '8px 12px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 12 }}>
                        {[
                          { label: '命令权限', value: user.commands || '—' },
                          { label: 'Key 模式',  value: user.keys    || '—' },
                          { label: '频道模式', value: user.channels || '—' },
                        ].map(row => (
                          <div key={row.label} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                            <span style={{ color: 'var(--text-muted)', width: 70, flexShrink: 0 }}>{row.label}</span>
                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{row.value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 新建用户弹窗 */}
            {newUserDlg && createPortal(
              <div className="modal-overlay" onClick={() => setNewUserDlg(false)}>
                <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 480 }}>
                  <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>新建 ACL 用户</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>用户名</label>
                      <input className="redis-search__input"
                        style={{ width: '100%', marginTop: 4, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', background: 'var(--surface-2)', fontSize: 12, boxSizing: 'border-box' }}
                        value={newUsername} onChange={e => setNewUsername(e.target.value)}
                        placeholder="用户名" />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>规则（空格分隔）</label>
                      <input className="redis-search__input"
                        style={{ width: '100%', marginTop: 4, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', background: 'var(--surface-2)', fontSize: 12, boxSizing: 'border-box' }}
                        value={newUserRules} onChange={e => setNewUserRules(e.target.value)}
                        placeholder="on nopass ~* +@all" />
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        示例：on &gt;password ~* +@read-only
                      </div>
                      {aclCats.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                          可用类别：{aclCats.slice(0, 20).map(c => `+@${c}`).join(' ')}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                    <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setNewUserDlg(false)}>取消</button>
                    <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                      onClick={doAddUser} disabled={!newUsername.trim() || aclSaving}>
                      {aclSaving ? <Loader2 size={12} className="spin" /> : null}
                      创建
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            <ConfirmDialog
              open={confirmDelUser !== null}
              title="删除 ACL 用户"
              desc={`确认删除用户 "${confirmDelUser}"？删除后该用户将立即失去访问权限，操作无法撤销。`}
              danger
              okText="删除"
              onOk={() => confirmDelUser && doDelUser(confirmDelUser)}
              onCancel={() => setConfirmDelUser(null)}
            />
          </div>
        )}

        {/* ══ R8.5 定时任务 ══════════════════════════════════════════════════ */}
        {tab === 'scheduler' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Redis 定时任务</span>
              <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={() => setTaskFormOpen(v => !v)}>
                <Plus size={12} /> 新建任务
              </button>
            </div>

            {taskFormOpen && (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>任务名称</label>
                    <input
                      style={{ width: '100%', marginTop: 3, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', boxSizing: 'border-box' }}
                      value={taskName} onChange={e => setTaskName(e.target.value)} placeholder="任务名称（留空则自动命名）" />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>任务类型</label>
                    <div style={{ marginTop: 3 }}>
                      <SearchableSelect mono={false}
                        value={taskType} onChange={v => setTaskType(v as 'bgsave' | 'inspect')}
                        items={[
                          { value: 'bgsave', label: '定时 BGSAVE（RDB 持久化）' },
                          { value: 'inspect', label: '定时巡检报告' },
                        ]} />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>执行间隔（分钟）</label>
                  <input type="number" min={1} max={1440}
                    style={{ width: 80, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', fontSize: 12, color: 'var(--text)' }}
                    value={taskInterval} onChange={e => setTaskInterval(+e.target.value)} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setTaskFormOpen(false)}>取消</button>
                  <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }} onClick={addTask}>创建</button>
                </div>
              </div>
            )}

            {tasks.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>暂无定时任务</div>
              : tasks.map(task => (
                  <div key={task.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 6,
                  }}>
                    <Clock size={13} style={{ color: task.enabled ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{task.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {task.type === 'bgsave' ? 'BGSAVE' : '巡检'} · 每 {task.intervalMinutes} 分钟
                        {task.lastRun && ` · 上次: ${fmtTime(task.lastRun)}`}
                        {task.lastStatus && (
                          <span style={{ color: task.lastStatus === 'ok' ? '#16a34a' : '#dc2626', marginLeft: 4 }}>
                            {task.lastStatus === 'ok' ? '✓' : '✗'} {task.lastMessage}
                          </span>
                        )}
                      </div>
                    </div>
                    <button className="cmd-act-btn" onClick={() => runTask(task)} title="立即执行">
                      <Play size={11} />
                    </button>
                    <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 8px', fontSize: 11 }}
                      onClick={() => toggleTask(task.id)}>
                      {task.enabled ? '暂停' : '启用'}
                    </button>
                    <button className="cmd-act-btn danger" onClick={() => removeTask(task.id)} title="删除">
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))
            }
          </div>
        )}

        {/* ══ R8.6 命令片段库 ════════════════════════════════════════════════ */}
        {tab === 'snippets' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>命令片段库</span>
              <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={() => setSnipFormOpen(v => !v)}>
                <Plus size={12} /> 新建片段
              </button>
            </div>

            {snipFormOpen && (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', fontSize: 12, color: 'var(--text)' }}
                    placeholder="片段名称" value={snipName} onChange={e => setSnipName(e.target.value)} />
                  <input
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}
                    placeholder="Redis 命令，如: INFO server" value={snipCmd} onChange={e => setSnipCmd(e.target.value)} />
                  <input
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', fontSize: 12, color: 'var(--text)' }}
                    placeholder="备注（可选）" value={snipDesc} onChange={e => setSnipDesc(e.target.value)} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                  <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setSnipFormOpen(false)}>取消</button>
                  <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                    onClick={addSnippet} disabled={!snipName.trim() || !snipCmd.trim()}>保存</button>
                </div>
              </div>
            )}

            {snippets.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
                  暂无命令片段。常用的 INFO、CONFIG GET、CLIENT LIST 命令可以保存在这里快速执行。
                </div>
              : snippets.map(snip => (
                  <div key={snip.id} style={{
                    border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--surface-2)', marginBottom: 8, overflow: 'hidden',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                      <BookOpen size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{snip.name}</div>
                        {snip.description && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{snip.description}</div>}
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>{snip.command}</div>
                      </div>
                      <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', padding: '3px 10px' }}
                        onClick={() => runSnippet(snip)} disabled={snipRunning === snip.id}
                        title="执行">
                        {snipRunning === snip.id ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                      </button>
                      <button className="cmd-act-btn danger" onClick={() => removeSnippet(snip.id)} title="删除">
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {snipResult[snip.id] && (
                      <div style={{
                        borderTop: '1px solid var(--border-subtle)', padding: '6px 12px',
                        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)',
                        background: 'var(--bg)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 150, overflowY: 'auto',
                      }}>
                        {snipResult[snip.id]}
                      </div>
                    )}
                  </div>
                ))
            }
          </div>
        )}
        {/* ══ R9.2 Sentinel ══════════════════════════════════════════════════ */}
        {tab === 'sentinel' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Sentinel 高可用监控</span>
              <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={loadSentinel} disabled={sentinelLoading}>
                {sentinelLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                刷新
              </button>
            </div>

            {sentinelError && <div className="redis-error">{sentinelError}</div>}

            {sentinelLoading ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 12 }}>检测中…</div>
            ) : isSentinel === false ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
                  <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: 'var(--warning)', lineHeight: 1.7 }}>
                    <b>当前连接不是 Redis Sentinel 实例。</b><br />
                    若需监控 Sentinel，请新建一个连接指向 Sentinel 实例（默认端口 26379），而非 Redis 主从实例。
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <b>常用 Sentinel 命令（连接到 Sentinel 实例后可在 CLI 面板执行）：</b>
                  {[
                    ['SENTINEL MASTERS', '查看所有被监控的主节点'],
                    ['SENTINEL SLAVES mymaster', '查看 mymaster 的从节点'],
                    ['SENTINEL SENTINELS mymaster', '查看哨兵集群成员'],
                    ['SENTINEL GET-MASTER-ADDR-BY-NAME mymaster', '获取当前主节点地址'],
                    ['SENTINEL FAILOVER mymaster', '手动触发故障转移（高危，强确认后操作）'],
                  ].map(([cmd, desc]) => (
                    <div key={cmd as string} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>{cmd as string}</code>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 10 }}>{desc as string}</span>
                      </div>
                      <button onClick={() => copyCmd(cmd as string)} style={{ color: recoveryCopied === cmd ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4, flexShrink: 0 }}>
                        {recoveryCopied === cmd ? <CheckCircle size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : isSentinel && sentinelMasters.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {sentinelMasters.map((m, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--surface-2)' }}>
                      <Shield size={14} color={m.status === 'ok' ? '#16a34a' : '#dc2626'} />
                      <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>{m.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.ip}:{m.port}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: m.status === 'ok' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{m.status}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: 12 }}>
                      {[['从节点数', m.slaves], ['哨兵数', m.sentinels], ['标志', m.flags]].map(([k, v]) => (
                        <div key={k as string} style={{ fontSize: 12 }}>
                          <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{k as string}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{v as string}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : isSentinel && sentinelMasters.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>此 Sentinel 实例未监控任何主节点</div>
            ) : null}
          </div>
        )}

        {/* ══ R9.1 Cluster ══════════════════════════════════════════════════════ */}
        {tab === 'cluster' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Cluster 集群拓扑</span>
              <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={loadCluster} disabled={clusterLoading}>
                {clusterLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                刷新
              </button>
            </div>

            {clusterError && <div className="redis-error">{clusterError}</div>}

            {clusterLoading ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 12 }}>检测中…</div>
            ) : isCluster === false ? (
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8 }}>
                <Network size={13} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                  当前实例 <b>未开启 Cluster 模式</b>（cluster_enabled=0）。
                  Cluster 模式需要在 redis.conf 中设置 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>cluster-enabled yes</code>。
                </div>
              </div>
            ) : isCluster ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Cluster Info 关键指标 */}
                {Object.keys(clusterInfo).length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {[
                      ['cluster_state', '集群状态'],
                      ['cluster_slots_assigned', '已分配槽位'],
                      ['cluster_known_nodes', '已知节点'],
                      ['cluster_size', '主节点数'],
                      ['total_cluster_links_buffer_limit_exceeded', '链路溢出'],
                      ['cluster_stats_messages_sent', '已发消息'],
                    ].map(([k, label]) => clusterInfo[k] !== undefined ? (
                      <div key={k as string} style={{ background: 'var(--surface-2)', borderRadius: 7, padding: '8px 12px' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label as string}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: clusterInfo[k as string] === 'ok' ? '#16a34a' : 'var(--text-bright)' }}>{clusterInfo[k as string]}</div>
                      </div>
                    ) : null)}
                  </div>
                )}

                {/* Cluster Nodes 列表 */}
                {clusterNodes.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead style={{ background: 'var(--surface-2)' }}>
                      <tr>
                        {['节点 ID', '地址', '角色', '槽位', '主节点引用', '标志'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {clusterNodes.map((n, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: n.flags.includes('fail') ? 'rgba(220,38,38,0.05)' : '' }}>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{n.id}…</td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{n.addr}</td>
                          <td style={{ padding: '5px 10px' }}>
                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: n.role === 'master' ? 'var(--accent-bg)' : 'rgba(22,163,74,0.1)', color: n.role === 'master' ? 'var(--accent)' : '#16a34a', fontWeight: 600 }}>
                              {n.role === 'master' ? '主' : '从'}
                            </span>
                          </td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{n.slots}</td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{n.masterRef || '—'}</td>
                          <td style={{ padding: '5px 10px', fontSize: 10, color: n.flags.includes('fail') ? '#dc2626' : 'var(--text-muted)' }}>{n.flags}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.65 }}>
                  ⚠ Cluster 模式下跨槽命令（如 MGET 多 key）会返回 MOVED 错误。本工具当前对 Cluster 仅支持单节点只读查询，跨槽批量操作请使用 redis-cli --cluster 或 Cluster-aware 客户端。
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* ══ R9.3 误删恢复引导 ═══════════════════════════════════════════════ */}
        {tab === 'recovery' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
              <AlertTriangle size={14} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: 'var(--error)', lineHeight: 1.7 }}>
                <b>Redis 无内置"闪回"功能。</b>发现误删后：<b>立即停止写入（或切只读）、不要重启</b>（RDB 快照会覆盖内存状态），联系运维争取最大恢复窗口。
              </div>
            </div>

            {[
              {
                title: '方案一：RDB 快照恢复（最常用）',
                risk: 'info' as const,
                lines: [
                  '1. 找到最近的 RDB 文件（dump.rdb，见 INFO persistence → rdb_last_save_time）',
                  '2. 停机，备份当前 dump.rdb（以防覆盖）',
                  '3. 用历史 RDB 文件替换，重启 Redis',
                  '4. 恢复到 RDB 生成时刻的数据（两次 BGSAVE 之间的写入无法恢复）',
                ],
                cmd: 'redis-cli -h 127.0.0.1 -p 6379 DEBUG RELOAD',
              },
              {
                title: '方案二：AOF 重放（精度最高）',
                risk: 'warn' as const,
                lines: [
                  '1. 找到 appendonly.aof 文件，确认 AOF 已开启（appendonly yes）',
                  '2. 用 redis-check-aof --fix 修复可能的截断问题',
                  '3. 手动编辑 AOF，删除导致误删的命令（DEL/FLUSHDB/FLUSHALL 等）',
                  '4. 停机，用修复后的 AOF 文件覆盖，重启 Redis',
                  '注意：AOF 文件可能很大，grep 关键 key 后定位删除命令行',
                ],
                cmd: 'redis-check-aof --fix appendonly.aof',
              },
              {
                title: '方案三：键空间通知排查（找删除来源）',
                risk: 'info' as const,
                lines: [
                  '开启 notify-keyspace-events Kgx（已写 key 的删除通知）',
                  '订阅 __keyevent@0__:del 频道（仅监听删除事件，按 db 编号调整）',
                  '可在删除原因未知时排查是哪个进程 / 客户端执行了 DEL',
                  '注意：开启后对性能有轻微影响，排查完毕后关闭（设为空字符串）',
                ],
                cmd: 'redis-cli CONFIG SET notify-keyspace-events Kgx\nredis-cli SUBSCRIBE __keyevent@0__:del',
              },
            ].map(s => (
              <div key={s.title} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: s.risk === 'info' ? 'rgba(59,130,246,0.06)' : 'rgba(234,88,12,0.06)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: s.risk === 'info' ? 'var(--accent)' : '#ea580c', background: s.risk === 'info' ? 'var(--accent-bg)' : 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '1px 6px' }}>
                    {s.risk === 'info' ? '推荐' : '中等'}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>{s.title}</span>
                </div>
                <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {s.lines.map((l, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65 }}>{l}</div>
                  ))}
                  <div style={{ position: 'relative', marginTop: 6 }}>
                    <pre style={{ margin: 0, padding: '8px 36px 8px 10px', background: 'var(--surface-2)', borderRadius: 6, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border)' }}>{s.cmd}</pre>
                    <button onClick={() => copyCmd(s.cmd)} style={{ position: 'absolute', top: 6, right: 6, color: recoveryCopied === s.cmd ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4 }}>
                      {recoveryCopied === s.cmd ? <CheckCircle size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
