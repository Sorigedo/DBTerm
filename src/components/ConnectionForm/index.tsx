import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Loader2, CheckCircle2, XCircle, Eye, EyeOff,
  FolderOpen, Plus, Trash2,
  Terminal, Server, Search,
} from 'lucide-react'
import {
  SiMysql, SiPostgresql, SiSqlite, SiRedis, SiClickhouse, SiMariadb, SiMongodb,
} from 'react-icons/si'
import { useAppStore } from '../../stores/appStore'
import { useGroupStore } from '../../stores/groupStore'
import { useSettingsStore } from '../../stores/settingsStore'
import SearchableSelect from '../DbTools/SearchableSelect'
import DriverManager from './DriverManager'
import type { ConnConfig, ConnType, TestResult } from '../../types'
import { buildConnUrl, connUrlScheme, isPostgresConnType, parseConnUrl } from '../../utils/connectionUrl'
import { normalizeDbExtraForSave, normalizeEnvLabelForSave, parseDbExtraJson } from '../../utils/connectionEnv'

import {
  IcoTiDB, IcoOceanBase, IcoKingBase, IcoOpenGauss, IcoSqlServer, IcoDuckDB, IcoOracle,
} from '../shared/DbIcons'

// ── 类型元数据 ────────────────────────────────────────────────
interface TypeMeta {
  type: ConnType; label: string; color: string
  icon: React.ReactNode
  iconSm: React.ReactNode
  hint?: string; desc?: string
}

const TYPE_LIST: TypeMeta[] = [
  { type: 'local',     label: '本地终端',  color: '#22c55e',
    icon:   <Terminal size={20} strokeWidth={1.8}/>,
    iconSm: <Terminal size={12} strokeWidth={2.2}/>,
    hint: 'Shell 会话', desc: '在本机上启动 Shell 会话' },
  { type: 'ssh',       label: 'SSH',       color: '#a78bfa',
    icon:   <Server size={20} strokeWidth={1.8}/>,
    iconSm: <Server size={12} strokeWidth={2.2}/>,
    hint: '远程连接', desc: '通过 SSH 协议连接远程主机' },
  { type: 'mysql',     label: 'MySQL',     color: '#4479A1',
    icon: <SiMysql size={22}/>,      iconSm: <SiMysql size={13}/>  },
  { type: 'postgres',  label: 'PostgreSQL',color: '#336791',
    icon: <SiPostgresql size={22}/>, iconSm: <SiPostgresql size={13}/> },
  { type: 'sqlite',    label: 'SQLite',    color: '#0f80cc',
    icon: <SiSqlite size={22}/>,     iconSm: <SiSqlite size={13}/>  },
  { type: 'redis',     label: 'Redis',     color: '#DC382D',
    icon: <SiRedis size={22}/>,      iconSm: <SiRedis size={13}/>   },
  { type: 'tidb',      label: 'TiDB',      color: '#e4392b',
    icon: <IcoTiDB size={20}/>,      iconSm: <IcoTiDB size={12}/>,   hint: 'MySQL 兼容' },
  { type: 'oceanBase', label: 'OceanBase', color: '#2dd4bf',
    icon: <IcoOceanBase size={20}/>, iconSm: <IcoOceanBase size={12}/>, hint: 'MySQL 兼容' },
  { type: 'mariadb',   label: 'MariaDB',   color: '#c0765a',
    icon: <SiMariadb size={22}/>,    iconSm: <SiMariadb size={13}/>,    hint: 'MySQL 兼容' },
  { type: 'kingBase',  label: '人大金仓',  color: '#818cf8',
    icon: <IcoKingBase size={20}/>,  iconSm: <IcoKingBase size={12}/>,  hint: 'PG 兼容' },
  { type: 'openGauss', label: 'openGauss', color: '#38bdf8',
    icon: <IcoOpenGauss size={20}/>, iconSm: <IcoOpenGauss size={12}/>, hint: 'PG 兼容' },
  { type: 'clickHouse',label: 'ClickHouse',color: '#FACC15',
    icon: <SiClickhouse size={22}/>, iconSm: <SiClickhouse size={13}/> },
  { type: 'mongodb',   label: 'MongoDB',   color: '#00ED64',
    icon: <SiMongodb size={22}/>,   iconSm: <SiMongodb size={13}/>   },
  { type: 'duckdb',    label: 'DuckDB',    color: '#FFD700',
    icon: <IcoDuckDB size={20}/>,   iconSm: <IcoDuckDB size={12}/>,    hint: '需下载驱动' },
  { type: 'sqlServer', label: 'SQL Server', color: '#CC2927',
    icon: <IcoSqlServer size={20}/>, iconSm: <IcoSqlServer size={12}/>, desc: '微软 SQL Server（tiberius 纯 Rust 驱动，无需外部文件）' },
  { type: 'oracle',    label: 'Oracle',     color: '#C74634',
    icon: <IcoOracle size={20}/>,   iconSm: <IcoOracle size={12}/>,     hint: '需下载驱动' },
]

const DEFAULTS: Partial<Record<ConnType, Partial<ConnConfig>>> = {
  ssh:       { port: 22,    username: 'root' },
  mysql:     { port: 3306,  username: 'root',     database: '' },
  postgres:  { port: 5432,  username: 'postgres', database: 'postgres' },
  duckdb:    {},
  sqlite:    {},
  redis:     { port: 6379,  database: '0' },
  tidb:      { port: 4000,  username: 'root',     database: '' },
  oceanBase: { port: 2881,  username: 'root',     database: '' },
  mariadb:   { port: 3306,  username: 'root',     database: '' },
  kingBase:  { port: 54321, username: 'system',   database: 'test' },
  openGauss: { port: 5432,  username: 'gaussdb',  database: 'postgres' },
  clickHouse:{ port: 8123,  username: 'default' },
  mongodb:   { port: 27017, username: '', database: '' },
  sqlServer: { port: 1433,  username: 'sa', database: '' },
  oracle:    { port: 1521,  username: 'system', database: '' },
}

function emptyConfig(type: ConnType): ConnConfig {
  return {
    id: '', name: '', type,
    host: type === 'local' ? '' : '127.0.0.1',
    useSsl: false, createdAt: 0, updatedAt: 0,
    ...(DEFAULTS[type] ?? {}),
  }
}

// ── SSH / 本地终端扩展配置（序列化进 ConnConfig.extraJson，统一走 Rust 后端存储）
type AuthType = 'password' | 'key' | 'mfa' | 'agent' | 'none'

interface SshTunnel {
  id: string; name: string; type: 'local' | 'remote' | 'dynamic'
  bindIP: string; bindPort: number; targetIP: string; targetPort: number; disabled: boolean
}
interface SshEnvVar { id: string; name: string; value: string }
interface SshExtra {
  authType: AuthType; note: string
  tunnels: SshTunnel[]; envVars: SshEnvVar[]
  proxyType: 'none' | 'http' | 'socks5'; proxyHost: string; proxyPort: number
  proxyUsername: string; proxyPassword: string; proxyTimeout: number
  enableSftp: boolean; sftpSudo: boolean; recordLog: boolean; enableCompression: boolean
  sftpCommand: string; heartbeatInterval: number; connectTimeout: number
  idleTimeoutMinutes: number; hostKeyPolicy: 'tofu' | 'strict' | 'skip'
  encoding: string; terminalType: string; sftpDefaultPath: string; initCommand: string
  // 跳板机
  jumpEnabled: boolean; jumpHost: string; jumpPort: number
  jumpUsername: string; jumpAuthType: 'password' | 'key' | 'agent'
  jumpKeyPath: string; jumpPassword: string
  extraJumps: ExtraJump[]  // 多跳链（第一跳之后的节点）
  // Agent 转发
  agentForwarding: boolean
}
interface ExtraJump {
  host: string; port: number; username: string
  authType: 'password' | 'key' | 'agent'
  keyPath: string; password: string
}
const DEFAULT_SSH_EXTRA: SshExtra = {
  authType: 'password', note: '',
  tunnels: [], envVars: [],
  proxyType: 'none', proxyHost: '127.0.0.1', proxyPort: 7890,
  proxyUsername: '', proxyPassword: '', proxyTimeout: 5,
  enableSftp: true, sftpSudo: false, recordLog: false, enableCompression: false,
  sftpCommand: 'sudo -S /usr/lib/openssh/sftp-server',
  heartbeatInterval: 30, connectTimeout: 30,
  idleTimeoutMinutes: 0, hostKeyPolicy: 'tofu',
  encoding: 'UTF-8', terminalType: 'xterm-256color',
  sftpDefaultPath: '', initCommand: '',
  jumpEnabled: false, jumpHost: '', jumpPort: 22,
  jumpUsername: '', jumpAuthType: 'password',
  jumpKeyPath: '', jumpPassword: '',
  extraJumps: [],
  agentForwarding: false,
}

// 通用文件选择：SSH 私钥 / SSL 证书等路径输入框的「浏览文件」按钮（无组件状态，置于模块级供各子表单复用）
async function pickFile(onPick: (path: string) => void, title = '选择文件') {
  const isTauri = '__TAURI_INTERNALS__' in window
  if (!isTauri) return
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ multiple: false, title })
    if (typeof selected === 'string') onPick(selected)
  } catch { /* 用户取消 */ }
}

function parseExtra(extraJson?: string): SshExtra {
  try {
    return extraJson ? { ...DEFAULT_SSH_EXTRA, ...JSON.parse(extraJson) } : { ...DEFAULT_SSH_EXTRA }
  } catch { return { ...DEFAULT_SSH_EXTRA } }
}

function makeDefaultSshExtra(): SshExtra {
  const s = useSettingsStore.getState()
  return {
    ...DEFAULT_SSH_EXTRA,
    connectTimeout: s.connectTimeout,
    heartbeatInterval: s.keepaliveEnabled ? s.keepaliveInterval : 0,
    encoding: s.encoding,
  }
}

// ── DB 连接扩展配置 ─────────────────────────────────────────────
interface DbDriverProp { id: string; key: string; value: string }
interface DbExtra {
  sslMode: 'disabled' | 'require' | 'verify-ca' | 'verify-full'
  sslCa: string; sslCert: string; sslKey: string
  sshTunnel: boolean
  sshHost: string; sshPort: number; sshUser: string
  sshAuthType: 'password' | 'key' | 'mfa' | 'agent' | 'none'
  sshPassword: string; sshKeyPath: string
  readOnly: boolean; isProduction: boolean
  connectTimeout: number; encoding: string
  initSql: string; driverProps: DbDriverProp[]; note: string
  urlParams: string
  // SQLite 专属
  sqliteReadonly: boolean
  sqliteBusyTimeout: number
  sqliteForeignKeys: boolean
  sqliteImmutable: boolean
  // PostgreSQL 专属
  pgSearchPath: string
  pgAppName: string
  // MongoDB 专属
  mongoAuthSource: string
  // DuckDB 专属
  duckAccessMode: 'read_write' | 'read_only'
  duckThreads: number
  duckMemoryLimit: string
  duckTempDir: string
  // SQL Server 专属
  ssInstance: string           // 命名实例（host\INSTANCE 中的 INSTANCE 部分）
  ssEncrypt: boolean           // 强制加密（SQL Server 2022 默认 true）
  ssTrustCert: boolean         // 跳过证书验证（开发/测试环境）
  ssAppIntent: 'ReadWrite' | 'ReadOnly'  // AG 只读副本路由
  // Redis 专属
  keySeparator: string         // key 树分隔符（默认 ':'）
  // ClickHouse 专属
  chProtocol: 'http' | 'tcp'   // HTTP(8123) 或 原生 TCP(9000)
  // Oracle 专属
  oraConnMode: 'service' | 'sid' | 'tns'  // 连接模式
  oraServiceName: string        // Service Name（推荐）
  oraSid: string                // SID（传统）
  oraTnsAlias: string           // TNS 别名
  oraRole: 'default' | 'sysdba' | 'sysoper'  // 登录角色
  oraSchema: string             // 会话开始后的当前 schema（ALTER SESSION SET CURRENT_SCHEMA）
}
const DEFAULT_DB_EXTRA: DbExtra = {
  sslMode: 'disabled', sslCa: '', sslCert: '', sslKey: '',
  sshTunnel: false, sshHost: '', sshPort: 22, sshUser: 'root',
  sshAuthType: 'password', sshPassword: '', sshKeyPath: '',
  readOnly: false, isProduction: false,
  connectTimeout: 30, encoding: 'UTF-8', initSql: '', driverProps: [], note: '',
  urlParams: '',
  sqliteReadonly: false, sqliteBusyTimeout: 5000, sqliteForeignKeys: true, sqliteImmutable: false,
  pgSearchPath: '', pgAppName: '',
  mongoAuthSource: '',
  duckAccessMode: 'read_write', duckThreads: 0, duckMemoryLimit: '', duckTempDir: '',
  ssInstance: '', ssEncrypt: true, ssTrustCert: true, ssAppIntent: 'ReadWrite',
  keySeparator: ':',
  chProtocol: 'http',
  oraConnMode: 'service', oraServiceName: '', oraSid: '', oraTnsAlias: '',
  oraRole: 'default', oraSchema: '',
}
function parseDbExtra(extraJson?: string): DbExtra {
  return { ...DEFAULT_DB_EXTRA, ...parseDbExtraJson(extraJson) }
}

function makeDefaultDbExtra(): DbExtra {
  const s = useSettingsStore.getState()
  return {
    ...DEFAULT_DB_EXTRA,
    connectTimeout: s.connectTimeout,
    encoding: s.encoding,
  }
}

// ── Color labels ───────────────────────────────────────────────
const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899']

// ── Props ──────────────────────────────────────────────────────
interface Props {
  initial?: ConnConfig | null
  initialType?: ConnType
  category?: 'terminal' | 'db'
  onClose: () => void
}

// ════════════════════════════════════════════════════════════════
export default function ConnectionForm({ initial, initialType, category, onClose }: Props) {
  const saveConnection = useAppStore((s) => s.saveConnection)

  const isEdit = !!initial
  const [step, setStep] = useState<'pick' | 'form'>(isEdit || initialType ? 'form' : 'pick')
  const [selType, setSelType] = useState<ConnType>(initial?.type ?? initialType ?? 'ssh')
  const [form, setForm] = useState<ConnConfig>(() => {
    if (!initial) return emptyConfig(selType)
    // 旧数据迁移：曾把「只读 / 生产环境」存在 extraJson（extra.readOnly / extra.isProduction），
    // 现统一为连接级字段 readonly 与 envLabel='prod'，读取时回填，避免双份重复字段。
    const base: ConnConfig = { ...initial }
    // 只读复选框回填：持久化字段是 readOnly（后端 read_only），统一回填到表单的 readonly
    base.readonly = !!(initial.readonly ?? initial.readOnly)
    if (initial.extraJson) {
      const ex = parseDbExtra(initial.extraJson)
      if (ex.readOnly) base.readonly = true
      if (ex.isProduction && base.envLabel === undefined) base.envLabel = 'prod'
    }
    return base
  })
  const [password, setPassword] = useState('')
  const [pwdEditing, setPwdEditing] = useState(!isEdit) // 编辑已有连接时默认锁定密码字段
  const [showPwd, setShowPwd] = useState(false)
  const [passwordLoaded, setPasswordLoaded] = useState(!isEdit)
  const [passwordDirty, setPasswordDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testClosing, setTestClosing] = useState(false)

  // 测试结果横幅自动消失：成功 4 秒、失败 8 秒，先淡出 0.25s 再移除；
  // 密钥变更类需要用户操作，不自动消失
  useEffect(() => {
    setTestClosing(false)
    if (!testResult) return
    if (!testResult.success && testResult.message.includes('密钥已变更')) return
    const hold = setTimeout(() => setTestClosing(true), testResult.success ? 4000 : 8000)
    return () => clearTimeout(hold)
  }, [testResult])
  useEffect(() => {
    if (!testClosing) return
    const t = setTimeout(() => { setTestResult(null); setTestClosing(false) }, 260)
    return () => clearTimeout(t)
  }, [testClosing])
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [duckReady, setDuckReady]       = useState(false)
  const [duckChecked, setDuckChecked]   = useState(false)  // probe 完成前不显示警告
  const [initialDbTab, setInitialDbTab] = useState<DbTab>('general')
  const [dbSearch, setDbSearch]         = useState('')

  // DR1.5: 探测驱动状态，检查 DuckDB 是否可用
  const recheckDuckReady = useCallback(() => {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) { setDuckChecked(true); return }
    import('@tauri-apps/api/core').then(({ invoke: inv }) =>
      inv<Record<string, unknown>[]>('dr_probe_all').then(list => {
        const duck = list.find((d: Record<string, unknown>) => (d.meta as Record<string, unknown>)?.driverType === 'duckdb')
        const status = (duck as Record<string, unknown> | undefined)?.status as Record<string, unknown> | string | undefined
        setDuckReady(status === 'ready' || (status as Record<string, unknown>)?.availableAt !== undefined)
        setDuckChecked(true)
      }).catch(() => setDuckChecked(true))
    )
  }, [])

  useEffect(() => { recheckDuckReady() }, [recheckDuckReady])

  // 监听驱动下载完成事件，DuckDB 就绪后更新 picker 状态
  useEffect(() => {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    let unlisten: (() => void) | null = null
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ driverType: string; done: boolean; error?: string }>('driver-download-progress', e => {
        if (e.payload.driverType === 'duckdb' && e.payload.done && !e.payload.error) {
          recheckDuckReady()
        }
      }).then(f => { unlisten = f }).catch(() => {})
    )
    return () => { unlisten?.() }
  }, [recheckDuckReady])

  // SQLite 文件健康状态
  const [sqliteHealth, setSqliteHealth] = useState<SqliteFileHealth | null>(null)
  useEffect(() => {
    if (selType !== 'sqlite' || !form.filePath?.trim()) { setSqliteHealth(null); return }
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<SqliteFileHealth>('sqlite_file_health', { path: form.filePath }).then(setSqliteHealth).catch(() => setSqliteHealth(null))
    )
  }, [selType, form.filePath])

  // SSH/本地 扩展配置
  const [sshExtra, setSshExtra] = useState<SshExtra>(() => {
    return initial ? parseExtra(initial.extraJson) : makeDefaultSshExtra()
  })

  // DB 扩展配置（仅数据库类型）
  const [dbExtra, setDbExtra] = useState<DbExtra>(() =>
    initial ? parseDbExtra(initial.extraJson) : makeDefaultDbExtra()
  )
  const patchDbExtra = useCallback((u: Partial<DbExtra>) =>
    setDbExtra(p => ({ ...p, ...u })), [])

  // 编辑模式不预加载密码：留空表示不修改，重新输入才更新

  const patch = useCallback((key: keyof ConnConfig, val: unknown) => {
    setForm(p => ({ ...p, [key]: val }))
    setErrors(p => { const n = { ...p }; delete n[key as string]; return n })
    setTestResult(null)
  }, [])

  const patchExtra = (update: Partial<SshExtra>) =>
    setSshExtra(p => ({ ...p, ...update }))

  const handlePasswordInput = useCallback((value: string) => {
    setPassword(value)
    setPasswordDirty(true)
    setPasswordLoaded(true)
    setPwdEditing(true)
    setTestResult(null)
  }, [])

  const revealSavedPassword = useCallback(async () => {
    if (!isEdit || !form.id) {
      setShowPwd(v => !v)
      return
    }
    if (!passwordLoaded) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const saved = await invoke<string | null>('get_connection_password', { id: form.id })
        setPassword(saved ?? '')
        setPasswordLoaded(true)
        setPwdEditing(true)
        setPasswordDirty(false)
        setShowPwd(true)
      } catch (e) {
        setTestResult({ success: false, message: `读取密码失败: ${String(e)}` })
      }
      return
    }
    setPwdEditing(true)
    setShowPwd(v => !v)
  }, [form.id, isEdit, passwordLoaded])

  function pickType(t: ConnType, autoTab?: DbTab) {
    setSelType(t)
    setForm(p => ({ ...emptyConfig(t), name: p.name, id: p.id }))
    setSshExtra(makeDefaultSshExtra())
    setDbExtra(makeDefaultDbExtra())
    setPassword('')
    setPasswordDirty(false)
    setPasswordLoaded(true)
    setPwdEditing(true)
    setShowPwd(false)
    setErrors({})
    setTestResult(null)
    setInitialDbTab(autoTab ?? 'general')
    setStep('form')
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = '请填写连接名称'
    const noHostTypes = new Set<string>(['sqlite', 'local', 'duckdb'])
    // Oracle TNS 模式通过 tnsnames.ora 解析地址，无需 host
    const skipHost = noHostTypes.has(selType) || (selType === 'oracle' && dbExtra.oraConnMode === 'tns')
    if (!skipHost && !form.host?.trim()) e.host = '请填写主机地址'
    if (selType === 'sqlite' && !form.filePath?.trim()) e.filePath = '请选择数据库文件'
    if (selType === 'duckdb' && !form.filePath?.trim() && form.database !== ':memory:') e.filePath = '请选择数据库文件或使用 :memory: 内存库'
    if (selType === 'oracle') {
      const mode = dbExtra.oraConnMode ?? 'service'
      if (mode === 'service' && !dbExtra.oraServiceName.trim()) e.oraServiceName = '请填写 Service Name'
      if (mode === 'sid'     && !dbExtra.oraSid.trim())         e.oraSid = '请填写 SID'
      if (mode === 'tns'     && !dbExtra.oraTnsAlias.trim())    e.oraTnsAlias = '请填写 TNS 别名'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleClearHostKey() {
    if (!form.host) return
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      await invoke('clear_host_key', { host: form.host, port: form.port ?? 22 })
      setTestResult(null)
      handleTest()
    } catch (e) {
      setTestResult({ success: false, message: String(e) })
    }
  }

  // 组装最终 ConnConfig（含 extraJson）；保存与测试共用，避免测试时漏带 SSL/隧道等扩展配置
  function composeConfig(): ConnConfig {
    if (selType === 'ssh' || selType === 'local') {
      return { ...form, extraJson: JSON.stringify(sshExtra) }
    }
    // DB 类：只读标志归一 —— 连接级 form.readonly 为唯一来源，写入后端读取的 readOnly 字段
    // （后端 ConnConfig.read_only ← JSON readOnly）。历史 bug：表单只写 readonly(小写 o)，
    // 后端读 readOnly，导致只读从不生效；旧 extraJson.readOnly 已在表单初始化时迁移到 form.readonly。
    const readOnly = !!form.readonly
    const envLabel = normalizeEnvLabelForSave(form.envLabel)
    const normalizedDbExtra = normalizeDbExtraForSave(dbExtra)
    if (selType === 'sqlite') {
      return { ...form, envLabel, readOnly, extraJson: JSON.stringify(normalizedDbExtra) }
    } else if (selType === 'duckdb') {
      return { ...form, envLabel, readOnly, extraJson: JSON.stringify(normalizedDbExtra) }
    }
    return { ...form, envLabel, readOnly, useSsl: dbExtra.sslMode !== 'disabled', extraJson: JSON.stringify(normalizedDbExtra) }
  }

  async function handleTest() {
    if (!validate()) return
    setTesting(true); setTestResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // 密码字段为空时由 Rust 侧自动从 keychain 读取，不再回传到前端
      const r = await invoke<TestResult>('test_connection', {
        config: composeConfig(),
        password: selType !== 'local' ? (password || undefined) : undefined,
      })
      setTestResult(r)
    } catch (e) {
      setTestResult({ success: false, message: String(e) })
    } finally { setTesting(false) }
  }

  async function pickDirectory() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: '选择工作目录' })
      if (typeof selected === 'string') patch('database', selected)
    } catch { /* 用户取消 */ }
  }

  async function handleSave() {
    if (!validate()) return
    setSaving(true)
    try {
      const configToSave: ConnConfig = composeConfig()
      const pwdToSave = passwordDirty ? password : undefined
      // 后端在 id 为空时生成 UUID，需用返回的 saved.id 归组
      const saved = await saveConnection(configToSave, selType !== 'local' ? pwdToSave : undefined)
      // 「新建连接到此分组」：新建（非编辑）且指定了目标分组时归入该分组
      if (!isEdit) {
        const targetGroup = useAppStore.getState().newConnGroup
        if (targetGroup && saved?.id) useGroupStore.getState().moveToGroup(saved.id, targetGroup)
      }
      onClose()
    } catch (e) {
      setErrors({ _global: String(e) })
    } finally { setSaving(false) }
  }

  const meta = TYPE_LIST.find(t => t.type === selType)!

  // ── Step 1: Type selection ──────────────────────────────────
  if (step === 'pick') {
    const TERMINAL_TYPES = new Set(['local', 'ssh'])
    const terminalTypes = TYPE_LIST.filter(t => TERMINAL_TYPES.has(t.type))
    const dbTypes       = TYPE_LIST.filter(t => !TERMINAL_TYPES.has(t.type))

    // 终端专属：统一卡片网格
    if (category === 'terminal') {
      return (
        <div className="modal-overlay">
          <div className="modal-box modal-box--picker-sm">
            <div className="modal-header">
              <span className="modal-title">新建终端连接</span>
              <button className="modal-close" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="picker-db-body">
              <div className="picker-group-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {terminalTypes.map(t => (
                  <button key={t.type} className="picker-card"
                    style={{ '--tc': t.color } as React.CSSProperties}
                    onClick={() => pickType(t.type)}>
                    <span className="picker-card-icon" style={{ background: t.color + '18', color: t.color }}>{t.icon}</span>
                    <span className="picker-card-name">{t.label}</span>
                    {t.hint && <span className="picker-card-hint">{t.hint}</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )
    }

    // 数据库专属：分组网格
    if (category === 'db') {
      const DB_GROUPS = [
        { label: '关系型数据库', types: ['mysql','postgres','sqlite','mariadb','sqlServer','oracle'] as ConnType[] },
        { label: '分布式 / 分析型', types: ['tidb','oceanBase','clickHouse','duckdb'] as ConnType[] },
        { label: '国产数据库',   types: ['kingBase','openGauss'] as ConnType[] },
        { label: 'NoSQL',        types: ['redis','mongodb'] as ConnType[] },
      ]
      const q = dbSearch.trim().toLowerCase()
      const matchGroups = DB_GROUPS.map(g => ({
        ...g,
        items: g.types.map(tp => dbTypes.find(t => t.type === tp)).filter(Boolean) as typeof dbTypes,
      })).map(g => ({
        ...g,
        items: q ? g.items.filter(t => t.label.toLowerCase().includes(q) || (t.hint ?? '').toLowerCase().includes(q)) : g.items,
      })).filter(g => g.items.length > 0)

      return (
        <div className="modal-overlay">
          <div className="modal-box modal-box--picker-db">
            <div className="modal-header">
              <span className="modal-title">新建数据库连接</span>
              <button className="modal-close" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="picker-search-wrap">
              <Search size={13} className="picker-search-icon" />
              <input
                className="picker-search-input"
                placeholder="搜索数据库类型…"
                value={dbSearch}
                onChange={e => setDbSearch(e.target.value)}
                autoFocus
              />
              {dbSearch && <button className="picker-search-clear" onClick={() => setDbSearch('')}><X size={11} /></button>}
            </div>
            <div className="modal-body picker-db-body">
              {matchGroups.map(g => (
                <div key={g.label} className="picker-group">
                  <div className="picker-group-label">{g.label}</div>
                  <div className="picker-group-grid">
                    {g.items.map(t => {
                      const notReady = t.type === 'duckdb' && !duckReady
                      return (
                        <button key={t.type}
                          className={`picker-card${notReady ? ' picker-card--dim' : ''}`}
                          title={notReady ? `需先在「驱动」标签下载驱动` : undefined}
                          style={{ '--tc': t.color } as React.CSSProperties}
                          onClick={() => notReady ? pickType(t.type as ConnType, 'drivers') : pickType(t.type as ConnType)}>
                          <span className="picker-card-icon" style={{ background: t.color + '18', color: t.color }}>
                            {t.icon}
                          </span>
                          <span className="picker-card-name">{t.label}</span>
                          {t.hint && <span className="picker-card-hint">{t.hint}</span>}
                          {notReady && <span className="picker-card-badge">需安装驱动</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    // 全部：紧凑横列终端 + 分组数据库 + 搜索
    const DB_GROUPS = [
      { label: '关系型', types: ['mysql','postgres','sqlite','mariadb','sqlServer','oracle'] as ConnType[] },
      { label: '分析 / 分布式', types: ['clickHouse','duckdb','tidb','oceanBase'] as ConnType[] },
      { label: '国产', types: ['kingBase','openGauss'] as ConnType[] },
      { label: 'NoSQL', types: ['redis','mongodb'] as ConnType[] },
    ]
    const q2 = dbSearch.trim().toLowerCase()
    const allMatchGroups = DB_GROUPS.map(g => ({
      ...g,
      items: g.types.map(tp => dbTypes.find(t => t.type === tp)).filter(Boolean) as typeof dbTypes,
    })).map(g => ({
      ...g,
      items: q2 ? g.items.filter(t => t.label.toLowerCase().includes(q2) || (t.hint ?? '').toLowerCase().includes(q2)) : g.items,
    })).filter(g => g.items.length > 0)

    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box--picker-all">
          <div className="modal-header">
            <span className="modal-title">新建连接</span>
            <button className="modal-close" onClick={onClose}><X size={16} /></button>
          </div>
          {/* 搜索栏 */}
          <div className="picker-search-wrap">
            <Search size={13} className="picker-search-icon" />
            <input className="picker-search-input" placeholder="搜索数据库类型…"
              value={dbSearch} onChange={e => setDbSearch(e.target.value)} autoFocus />
            {dbSearch && <button className="picker-search-clear" onClick={() => setDbSearch('')}><X size={11} /></button>}
          </div>
          <div className="modal-body picker-all-body">
            {/* 终端：与数据库统一小方卡网格，仅无搜索时显示 */}
            {!q2 && (<>
              <div className="picker-all-section-label">终端</div>
              <div className="picker-group-grid" style={{ marginBottom: 16 }}>
                {terminalTypes.map(t => (
                  <button key={t.type} className="picker-card"
                    style={{ '--tc': t.color } as React.CSSProperties}
                    onClick={() => pickType(t.type)}>
                    <span className="picker-card-icon" style={{ background: t.color + '18', color: t.color }}>{t.icon}</span>
                    <span className="picker-card-name">{t.label}</span>
                    {t.hint && <span className="picker-card-hint">{t.hint}</span>}
                  </button>
                ))}
              </div>
              <div className="picker-all-section-label">数据库</div>
            </>)}
            {/* 数据库：分组卡片 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {allMatchGroups.map(g => (
                <div key={g.label}>
                  <div className="picker-group-label">{g.label}</div>
                  <div className="picker-group-grid">
                    {g.items.map(t => {
                      const notReady = t.type === 'duckdb' && !duckReady
                      return (
                        <button key={t.type}
                          className={`picker-card${notReady ? ' picker-card--dim' : ''}`}
                          title={notReady ? '需先下载驱动' : undefined}
                          style={{ '--tc': t.color } as React.CSSProperties}
                          onClick={() => notReady ? pickType(t.type as ConnType, 'drivers') : pickType(t.type as ConnType)}>
                          <span className="picker-card-icon" style={{ background: t.color + '18', color: t.color }}>{t.icon}</span>
                          <span className="picker-card-name">{t.label}</span>
                          {t.hint && <span className="picker-card-hint">{t.hint}</span>}
                          {notReady && <span className="picker-card-badge">需安装驱动</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: Config form ─────────────────────────────────────
  const isTofuErr = testResult && !testResult.success && testResult.message.includes('密钥已变更')
  const footer = (
    <div className="modal-footer cf-footer">
      {/* 测试结果 / 全局错误：占位行，位于按钮上方，不遮盖表单 */}
      {(testResult || errors._global) && (
        <div className={`cf-toast${testClosing ? ' cf-toast--closing' : ''}`}>
          {testResult && (
            <div className={`test-result ${testResult.success ? 'ok' : 'fail'}`} style={{ margin: 0, wordBreak: 'break-word' }}>
              {testResult.success ? <CheckCircle2 size={14} style={{ flexShrink: 0 }}/> : <XCircle size={14} style={{ flexShrink: 0 }}/>}
              <span style={{ flex: 1 }}>
                {isTofuErr
                  ? `主机 ${form.host}:${form.port ?? 22} 的 SSH 密钥已变更，请清除旧记录后重试`
                  : testResult.message}
                {testResult.latencyMs != null && testResult.success && <span className="latency"> · {testResult.latencyMs} ms</span>}
              </span>
              {isTofuErr && (
                <button onClick={handleClearHostKey}
                  style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: '#fff', background: 'var(--error)', border: 'none', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  清除记录并重连
                </button>
              )}
            </div>
          )}
          {errors._global && <div className="global-err" style={{ margin: 0 }}>{errors._global}</div>}
        </div>
      )}
      <div className="cf-footer-actions">
        <button className="btn-test" onClick={handleTest} disabled={testing}>
          {testing ? <><Loader2 size={13} className="spin" /> 测试中…</> : '测试连接'}
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {!isEdit && !initialType && <button className="btn-cancel" onClick={() => setStep('pick')}>← 返回</button>}
          <button className="btn-cancel" onClick={onClose}>取消</button>
          <button className="btn-save" onClick={handleSave} disabled={saving}>
            {saving ? <><Loader2 size={13} className="spin" /> 保存中…</> : '保存'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── 本地终端 ─────────────────────────────────────────────────
  if (selType === 'local') {
    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box--local">
          <div className="modal-header">
            <span className="modal-title">终端配置编辑</span>
            <button className="modal-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body">

            {/* 颜色标签 + 名称 */}
            <div className="local-top-row">
              <div className="local-color-col">
                <label className="local-label">颜色标签</label>
                <div className="color-label-row" style={{ marginTop: 8 }}>
                  {COLORS.map(c => (
                    <button key={c}
                      className={`color-dot${form.color === c ? ' selected' : ''}`}
                      style={{ background: c }}
                      onClick={() => patch('color', form.color === c ? '' : c)} />
                  ))}
                  {form.color && (
                    <button className="color-dot color-dot--clear"
                      onClick={() => patch('color', '')}>✕</button>
                  )}
                </div>
              </div>
              <div className="local-name-col">
                <label className="local-label local-label--required">名称</label>
                <input className={errors.name ? 'error' : ''}
                  value={form.name} onChange={e => patch('name', e.target.value)}
                  style={{ marginTop: 8 }}
                  autoCapitalize="off" autoCorrect="off" autoComplete="off" />
                {errors.name && <span className="field-err">{errors.name}</span>}
              </div>
            </div>

            {/* Shell */}
            <div className="local-field">
              <label className="local-label">Shell</label>
              <ShellPicker value={form.host ?? ''} onChange={v => patch('host', v)} />
            </div>

            {/* 工作目录 */}
            <div className="local-field">
              <label className="local-label">
                工作目录
                <span className="field-hint">留空使用 $HOME</span>
              </label>
              <div className="input-addon" style={{ marginTop: 8 }}>
                <input placeholder="~" value={form.database ?? ''}
                  onChange={e => patch('database', e.target.value)}
                  autoComplete="off" />
                <button className="addon-btn" data-tip="浏览目录" onClick={pickDirectory}>
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            {/* 初始命令 */}
            <div className="local-field">
              <label className="local-label">
                初始命令
                <span className="field-hint">连接后自动执行</span>
              </label>
              <input style={{ marginTop: 8 }} placeholder="例：tmux attach || tmux"
                value={sshExtra.initCommand}
                onChange={e => patchExtra({ initCommand: e.target.value })} />
            </div>

            {/* 字符编码 + 备注 */}
            <div className="form-grid" style={{ marginTop: 0 }}>
              <div className="form-field" style={{ flex: 1 }}>
                <label>字符编码</label>
                <SearchableSelect
                  value={sshExtra.encoding}
                  onChange={v => patchExtra({ encoding: v })}
                  options={['UTF-8','GBK','GB2312','Latin-1']}
                  mono={false} />
              </div>
              <div className="form-field" style={{ flex: 2 }}>
                <label>备注</label>
                <input placeholder="可选备注" value={sshExtra.note}
                  onChange={e => patchExtra({ note: e.target.value })} />
              </div>
            </div>

          </div>

          {footer}
        </div>
      </div>
    )
  }

  // ── SSH 表单 ─────────────────────────────────────────────────
  if (selType === 'ssh') {
    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box--lg">
          <div className="modal-header">
            <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ background: '#a78bfa1a', color: '#a78bfa', width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>&gt;_</span>
              {isEdit ? '编辑 SSH 连接' : '新建 SSH 连接'}
            </span>
            <button className="modal-close" onClick={onClose}><X size={16} /></button>
          </div>
          <SshForm
            form={form} patch={patch}
            password={password} setPassword={handlePasswordInput}
            showPwd={showPwd}
            extra={sshExtra} patchExtra={patchExtra}
          errors={errors}
          pwdEditing={pwdEditing}
          passwordLoaded={passwordLoaded}
          onTogglePwd={revealSavedPassword}
        />
          {footer}
        </div>
      </div>
    )
  }

  // ── 数据库表单（分 Tab）────────────────────────────────────────
  return (
    <div className="modal-overlay">
      <div className="modal-box modal-box--lg">
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="modal-type-abbr" style={{ background: meta.color + '20', color: meta.color }}>
              {meta.iconSm}
            </span>
            {isEdit ? `编辑 ${meta.label}` : `新建 ${meta.label}`}
            {form.envLabel === 'prod' && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--error)', background: 'var(--error-bg)',
                border: '1px solid rgba(240,96,96,0.35)', borderRadius: 4, padding: '1px 5px', letterSpacing: '0.03em' }}>
                生产环境
              </span>
            )}
            {form.readonly && (
              <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', background: '#a78bfa18',
                border: '1px solid #a78bfa40', borderRadius: 4, padding: '1px 5px' }}>
                只读
              </span>
            )}
          </span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <DbForm
          form={form} patch={patch} selType={selType}
          password={password} setPassword={handlePasswordInput}
          showPwd={showPwd}
          extra={dbExtra} patchExtra={patchDbExtra}
          errors={errors}
          pwdEditing={pwdEditing}
          passwordLoaded={passwordLoaded}
          onTogglePwd={revealSavedPassword}
          isEdit={isEdit}
          meta={meta}
          sqliteHealth={sqliteHealth}
          initialTab={initialDbTab}
          duckReady={duckReady}
          duckChecked={duckChecked}
        />
        {footer}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// DB Form (4 tabs: 常规 / SSL·TLS / SSH隧道 / 高级)
// Navicat / TablePlus 风格
// ════════════════════════════════════════════════════════════════

type DbTab = 'general' | 'ssl' | 'tunnel' | 'advanced' | 'drivers'
const DB_TABS_BASE: { id: DbTab; label: string }[] = [
  { id: 'general',  label: '常规' },
  { id: 'ssl',      label: 'SSL / TLS' },
  { id: 'tunnel',   label: 'SSH 隧道' },
  { id: 'advanced', label: '高级' },
]
// 仅需要外部驱动的连接类型才显示驱动 tab
const DRIVER_TYPES = new Set<ConnType>(['duckdb', 'sqlServer', 'oracle'])
// ConnType → 对应 driverType key（与后端 dr_list 返回的 driverType 字段一致）
const CONN_DRIVER_MAP: Partial<Record<ConnType, string>> = {
  duckdb:    'duckdb',
  sqlServer: 'sqlserver',
  oracle:    'oracle',
}

interface SqliteFileHealth { validMagic: boolean; hasJournal: boolean; hasWal: boolean; hasShm: boolean; journalSizeBytes: number; walSizeBytes: number; fileSizeBytes: number }
interface DbFormProps {
  form: ConnConfig; patch: (k: keyof ConnConfig, v: unknown) => void
  selType: ConnType
  password: string; setPassword: (s: string) => void
  showPwd: boolean
  extra: DbExtra; patchExtra: (u: Partial<DbExtra>) => void
  errors: Record<string, string>
  pwdEditing: boolean
  passwordLoaded: boolean; onTogglePwd: () => void
  isEdit: boolean
  meta: TypeMeta
  sqliteHealth?: SqliteFileHealth | null
  initialTab?: DbTab
  duckReady?: boolean
  duckChecked?: boolean
}

const SSL_MODES: { value: DbExtra['sslMode']; label: string; desc: string }[] = [
  { value: 'disabled',    label: '禁用',     desc: '明文传输' },
  { value: 'require',     label: '需要',      desc: '加密，不验签' },
  { value: 'verify-ca',   label: '验证 CA',   desc: '验证 CA 证书' },
  { value: 'verify-full', label: '完全验证',  desc: '验证证书+主机名' },
]

// ── URL 双向同步辅助 ──────────────────────────────────────────
function DbForm({ form, patch, selType, password, setPassword, showPwd,
  extra, patchExtra, errors, pwdEditing, passwordLoaded, onTogglePwd, isEdit, meta, sqliteHealth, initialTab,
  duckReady, duckChecked }: DbFormProps) {
  const [tab, setTab] = useState<DbTab>(initialTab ?? 'general')
  const [showSshPwd, setShowSshPwd] = useState(false)
  const isSqlite     = selType === 'sqlite'
  const isRedis      = selType === 'redis'
  const isMongodb    = selType === 'mongodb'
  const isDuck       = selType === 'duckdb'
  const isSqlServer  = selType === 'sqlServer'
  const isOracle     = selType === 'oracle'
  const isClickHouse = selType === 'clickHouse'
  const hasDB        = !['redis', 'sqlite', 'mongodb', 'duckdb'].includes(selType)
  const isPg         = isPostgresConnType(selType)

  async function pickSqliteFile() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        title: '选择 SQLite 数据库文件',
        filters: [
          { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 's3db', 'sl3'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (typeof selected === 'string') patch('filePath', selected)
    } catch { /* 用户取消 */ }
  }

  async function newSqliteFile() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selected = await save({
        title: '新建 SQLite 数据库文件',
        defaultPath: 'database.sqlite',
        filters: [
          { name: 'SQLite 数据库', extensions: ['sqlite', 'db', 'sqlite3'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (typeof selected === 'string') patch('filePath', selected)
    } catch { /* 用户取消 */ }
  }

  async function pickDuckFile() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        title: '选择 DuckDB 数据库文件',
        filters: [
          { name: 'DuckDB 数据库', extensions: ['duckdb', 'db'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (typeof selected === 'string') { patch('filePath', selected); patch('database', '') }
    } catch { /* 用户取消 */ }
  }

  async function newDuckFile() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selected = await save({
        title: '新建 DuckDB 数据库文件',
        defaultPath: 'database.duckdb',
        filters: [
          { name: 'DuckDB 数据库', extensions: ['duckdb'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (typeof selected === 'string') { patch('filePath', selected); patch('database', '') }
    } catch { /* 用户取消 */ }
  }

  // URL 双向同步
  const hasHiddenSavedPassword = isEdit && !passwordLoaded
  const [urlStr, setUrlStr]     = useState(() => buildConnUrl(form, selType, password, extra.urlParams, showPwd, hasHiddenSavedPassword))
  const urlEditingRef           = useRef(false)
  useEffect(() => {
    if (!urlEditingRef.current) setUrlStr(buildConnUrl(form, selType, password, extra.urlParams, showPwd, hasHiddenSavedPassword))
  }, [form.host, form.port, form.username, form.database, password, showPwd, hasHiddenSavedPassword, selType, extra.urlParams])

  function handleUrlChange(val: string) {
    setUrlStr(val)
    if (!val.trim()) return
    const p = parseConnUrl(val)
    if (p.host      !== undefined) patch('host',     p.host)
    if (p.port      !== undefined) patch('port',     p.port)
    if (p.username  !== undefined) patch('username', p.username)
    if (p.database  !== undefined) patch('database', p.database)
    if (p.password  !== undefined) setPassword(p.password)
    if (p.urlParams !== undefined) patchExtra({ urlParams: p.urlParams })
  }

  const dbTabs = DRIVER_TYPES.has(selType)
    ? [...DB_TABS_BASE, { id: 'drivers' as DbTab, label: '驱动' }]
    : DB_TABS_BASE

  return (
    <>
      <div className="cf-tab-bar">
        {dbTabs.map(t => (
          <button key={t.id} className={`cf-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="modal-body cf-pane">

        {/* ── 常规 ── */}
        {tab === 'general' && (
          <div className="dbf-rows">

            {/* URL（可选）— 置顶，粘贴自动解析 */}
            {!isSqlite && connUrlScheme(selType) && (
              <div className="dbf-row">
                <span className="dbf-label">URL（可选）</span>
                <div className="dbf-val">
                  <input className="conn-url-input"
                    value={urlStr}
                    placeholder={`${connUrlScheme(selType)}://user:password@host:port/database`}
                    onChange={e => handleUrlChange(e.target.value)}
                    onFocus={() => { urlEditingRef.current = true }}
                    onBlur={() => {
                      urlEditingRef.current = false
                      setUrlStr(buildConnUrl(form, selType, password, extra.urlParams, showPwd, hasHiddenSavedPassword))
                    }}
                    spellCheck={false} autoComplete="off" />
                </div>
              </div>
            )}

            {/* 名称 */}
            <div className="dbf-row">
              <span className="dbf-label">名称</span>
              <div className="dbf-val">
                <input className={errors.name ? 'error' : ''} placeholder={`${meta.label} 连接，留空则自动生成`}
                  value={form.name} onChange={e => patch('name', e.target.value)} />
                {errors.name && <span className="field-err">{errors.name}</span>}
              </div>
            </div>

            {/* 颜色 */}
            <div className="dbf-row">
              <span className="dbf-label">颜色</span>
              <div className="dbf-val dbf-val--colors">
                {COLORS.map(c => (
                  <button key={c} className={`db-color-dot${form.color === c ? ' sel' : ''}`}
                    style={{ background: c }}
                    onClick={() => patch('color', form.color === c ? '' : c)} />
                ))}
                {form.color && (
                  <button className="db-color-clear" onClick={() => patch('color', '')}>✕</button>
                )}
              </div>
            </div>

            {isSqlite ? (<>
              <div className="dbf-row">
                <span className="dbf-label">数据库文件</span>
                <div className="dbf-val">
                  <div className="input-addon">
                    <input className={errors.filePath ? 'error' : ''} placeholder="/path/to/database.sqlite"
                      value={form.filePath ?? ''} onChange={e => patch('filePath', e.target.value)} />
                    <button className="addon-btn" data-tip="浏览已有文件" onClick={pickSqliteFile}><FolderOpen size={14} /></button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button onClick={newSqliteFile}
                      style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                      + 新建文件
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      文件不存在时 SQLite 将自动创建
                    </span>
                  </div>
                  {errors.filePath && <span className="field-err">{errors.filePath}</span>}
                  {sqliteHealth && !sqliteHealth.validMagic && (
                    <span className="field-err">不是有效的 SQLite 数据库文件（魔数校验失败）</span>
                  )}
                  {sqliteHealth?.validMagic && sqliteHealth.hasJournal && (
                    <span style={{ color: 'var(--warning)', fontSize: 11, marginTop: 2, display: 'block' }}>
                      ⚠ 检测到热日志（-journal，{Math.round(sqliteHealth.journalSizeBytes / 1024)} KB），存在未回放事务，建议先用 SQLite CLI 回放
                    </span>
                  )}
                  {sqliteHealth?.validMagic && sqliteHealth.hasWal && (
                    <span style={{ color: '#ca8a04', fontSize: 11, marginTop: 2, display: 'block' }}>
                      ℹ 检测到 WAL 文件（-wal，{Math.round(sqliteHealth.walSizeBytes / 1024)} KB），上次连接可能未完成检查点，正常连接后会自动处理
                    </span>
                  )}
                </div>
              </div>
              {/* S0.2 SQLite 打开选项 */}
              <div className="dbf-row">
                <span className="dbf-label">打开选项</span>
                <div className="dbf-val" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                    <input type="checkbox" checked={extra.sqliteReadonly ?? false}
                      onChange={e => patchExtra({ sqliteReadonly: e.target.checked })} />
                    只读模式（mode=ro + PRAGMA query_only=ON 双保险）
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                    <input type="checkbox" checked={extra.sqliteForeignKeys ?? true}
                      onChange={e => patchExtra({ sqliteForeignKeys: e.target.checked })} />
                    启用外键约束（foreign_keys=ON，推荐）
                  </label>
                  {(() => {
                    const safeForImmutable = sqliteHealth?.validMagic && !sqliteHealth.hasJournal && !sqliteHealth.hasWal
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: safeForImmutable ? 'pointer' : 'not-allowed', color: safeForImmutable ? 'var(--text)' : 'var(--text-muted)', opacity: safeForImmutable ? 1 : 0.5 }}>
                          <input type="checkbox" disabled={!safeForImmutable}
                            checked={extra.sqliteImmutable ?? false}
                            onChange={e => patchExtra({ sqliteImmutable: e.target.checked })} />
                          immutable=1（超高速只读，仅当无热日志且确认无并发写时使用）
                        </label>
                        {!safeForImmutable && form.filePath?.trim() && (
                          <span style={{ fontSize: 11, color: 'var(--error)', paddingLeft: 18 }}>检测到 WAL/热日志或魔数不符，禁用 immutable 以防止读到损坏数据</span>
                        )}
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)', minWidth: 100 }}>锁等待超时</span>
                    <input type="number" min={0} max={60000} style={{ width: 80 }}
                      value={extra.sqliteBusyTimeout ?? 5000}
                      onChange={e => patchExtra({ sqliteBusyTimeout: Number(e.target.value) || 5000 })} />
                    <span style={{ color: 'var(--text-muted)' }}>ms（默认 5000ms）</span>
                  </div>
                </div>
              </div>
            </>) : isDuck ? (<>
              {/* DD0.1 驱动状态：已就绪不显示警告；probe 未完成前也不显示（避免闪烁） */}
              {duckChecked && !duckReady && (
                <div className="dbf-row dbf-row--flags">
                  <span className="dbf-label">驱动状态</span>
                  <div className="dbf-val">
                    <div className="dlg-alert-warning" style={{ borderRadius: 8, fontSize: 12 }}>
                      <span>DuckDB 需要外部驱动（libduckdb）才能连接。请前往「<strong>驱动管理</strong>」标签下载并配置 libduckdb 后再使用。</span>
                    </div>
                  </div>
                </div>
              )}
              {/* DD0.1 存储模式（文件库 / 内存库） */}
              <div className="dbf-row">
                <span className="dbf-label">存储模式</span>
                <div className="dbf-val" style={{ display: 'flex', gap: 16 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="duck-mode" value="file"
                      checked={form.database !== ':memory:'}
                      onChange={() => { patch('database', ''); }} />
                    文件库
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="duck-mode" value="memory"
                      checked={form.database === ':memory:'}
                      onChange={() => { patch('database', ':memory:'); patch('filePath', ''); }} />
                    内存库
                  </label>
                  {form.database === ':memory:' && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      使用 :memory:，关闭连接后数据消失
                    </span>
                  )}
                </div>
              </div>
              {/* DD0.1 文件路径（仅文件库模式） */}
              {form.database !== ':memory:' && (
                <div className="dbf-row dbf-row--flags">
                  <span className="dbf-label">数据库文件</span>
                  <div className="dbf-val">
                    <div className="input-addon">
                      <input className={errors.filePath ? 'error' : ''}
                        placeholder="/path/to/database.duckdb"
                        value={form.filePath ?? ''}
                        onChange={e => patch('filePath', e.target.value)} />
                      <button className="addon-btn" data-tip="浏览已有文件" onClick={pickDuckFile}><FolderOpen size={14} /></button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                      <button onClick={newDuckFile}
                        style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                          background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
                        + 新建文件
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>文件不存在时 DuckDB 将自动创建</span>
                    </div>
                    {errors.filePath && <span className="field-err">{errors.filePath}</span>}
                  </div>
                </div>
              )}
              {/* DD0.2 打开选项 */}
              <div className="dbf-row">
                <span className="dbf-label">访问模式</span>
                <div className="dbf-val">
                  <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text)' }}>
                      <input type="radio" name="duck-access" value="read_write"
                        checked={(extra.duckAccessMode ?? 'read_write') === 'read_write'}
                        onChange={() => patchExtra({ duckAccessMode: 'read_write' })} />
                      读写（read_write）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text)' }}>
                      <input type="radio" name="duck-access" value="read_only"
                        checked={extra.duckAccessMode === 'read_only'}
                        onChange={() => patchExtra({ duckAccessMode: 'read_only' })} />
                      只读（read_only，双重保险）
                    </label>
                  </div>
                </div>
              </div>
              {/* threads / memory_limit */}
              <div className="dbf-row">
                <span className="dbf-label">并行线程数</span>
                <div className="dbf-val" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="number" min={0} max={256} style={{ width: 80 }}
                    value={extra.duckThreads ?? 0}
                    onChange={e => patchExtra({ duckThreads: Number(e.target.value) })} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>0 = 自动（按 CPU 核心数）</span>
                </div>
              </div>
              <div className="dbf-row">
                <span className="dbf-label">内存上限</span>
                <div className="dbf-val" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input placeholder="例：4GB（留空不限制）" style={{ maxWidth: 200 }}
                    value={extra.duckMemoryLimit ?? ''}
                    onChange={e => patchExtra({ duckMemoryLimit: e.target.value })}
                    spellCheck={false} autoComplete="off" />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>防止分析大文件时吃满内存</span>
                </div>
              </div>
              <div className="dbf-row">
                <span className="dbf-label">溢写目录</span>
                <div className="dbf-val" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="input-addon" style={{ flex: 1 }}>
                    <input placeholder="留空使用系统临时目录"
                      value={extra.duckTempDir ?? ''}
                      onChange={e => patchExtra({ duckTempDir: e.target.value })}
                      spellCheck={false} autoComplete="off" />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>查询中间结果溢写路径</span>
                </div>
              </div>
            </>) : (<>
              {/* 主机 + 端口 */}
              <div className="dbf-row">
                <span className="dbf-label">主机</span>
                <div className="dbf-val" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 4 }}>
                    <input className={errors.host ? 'error' : ''} placeholder="127.0.0.1"
                      value={form.host ?? ''} onChange={e => patch('host', e.target.value)} />
                    {errors.host && <span className="field-err">{errors.host}</span>}
                  </div>
                  <input type="number" style={{ flex: 1, minWidth: 80 }}
                    value={form.port ?? ''}
                    onChange={e => patch('port', e.target.value ? Number(e.target.value) : undefined)} />
                </div>
              </div>

              {/* 用户名 */}
              <div className="dbf-row">
                <span className="dbf-label">用户名</span>
                <div className="dbf-val">
                  <input value={form.username ?? ''} onChange={e => patch('username', e.target.value)} autoComplete="off" />
                </div>
              </div>

              {/* 密码 */}
              <div className="dbf-row">
                <span className="dbf-label">密码</span>
                <div className="dbf-val">
                  {isEdit && !pwdEditing ? (
                    <div className="input-addon">
                      <input type="password" value="••••••••" readOnly style={{ cursor: 'default' }} />
                      <button className="addon-btn" data-tip="显示已保存密码" onClick={onTogglePwd}><Eye size={14} /></button>
                    </div>
                  ) : (
                    <div className="input-addon">
                      <input type={showPwd ? 'text' : 'password'} value={password}
                        onChange={e => setPassword(e.target.value)}
                        autoComplete="new-password" placeholder={isEdit ? '输入新密码' : ''} />
                      <button className="addon-btn" data-tip={showPwd ? '隐藏密码' : (passwordLoaded ? '显示密码' : '读取并显示已保存密码')} onClick={onTogglePwd}>
                        {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 数据库 */}
              {hasDB && (
                <div className="dbf-row">
                  <span className="dbf-label">数据库</span>
                  <div className="dbf-val">
                    <input placeholder="可选" value={form.database ?? ''}
                      onChange={e => patch('database', e.target.value)} />
                  </div>
                </div>
              )}
              {isRedis && (
                <div className="dbf-row">
                  <span className="dbf-label">DB 编号</span>
                  <div className="dbf-val">
                    <input type="number" min={0} max={15} placeholder="0–15"
                      value={form.database ?? '0'} onChange={e => patch('database', e.target.value)} />
                  </div>
                </div>
              )}
              {isRedis && (
                <div className="dbf-row">
                  <span className="dbf-label">Key 分隔符</span>
                  <div className="dbf-val">
                    <input style={{ width: 80 }} maxLength={4} placeholder=":"
                      value={extra.keySeparator ?? ':'}
                      onChange={e => patchExtra({ keySeparator: e.target.value })} />
                    <span className="field-hint" style={{ marginLeft: 8 }}>key 树按此字符分层（默认 :，部分项目用 / 或 .）</span>
                  </div>
                </div>
              )}

              {/* ClickHouse 专属：协议 HTTP / 原生 TCP */}
              {isClickHouse && (
                <div className="dbf-row">
                  <span className="dbf-label">连接协议</span>
                  <div className="dbf-val" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['http', 'tcp'] as const).map(p => (
                        <button key={p} type="button"
                          onClick={() => {
                            patchExtra({ chProtocol: p })
                            // 切到 TCP 时把端口顺手提示为 9000（仅当当前是默认 8123 / 空）
                            if (p === 'tcp' && (!form.port || form.port === 8123)) patch('port', 9000)
                            if (p === 'http' && form.port === 9000) patch('port', 8123)
                          }}
                          style={{
                            padding: '5px 14px', fontSize: 12.5, borderRadius: 7,
                            border: `1px solid ${(extra.chProtocol ?? 'http') === p ? 'var(--accent)' : 'var(--border)'}`,
                            background: (extra.chProtocol ?? 'http') === p ? 'var(--accent-bg)' : 'var(--surface-2)',
                            color: (extra.chProtocol ?? 'http') === p ? 'var(--accent)' : 'var(--text)',
                            fontWeight: (extra.chProtocol ?? 'http') === p ? 600 : 400, cursor: 'pointer',
                          }}>
                          {p === 'http' ? 'HTTP (8123)' : '原生 TCP (9000)'}
                        </button>
                      ))}
                    </div>
                    <span className="field-hint">
                      {(extra.chProtocol ?? 'http') === 'tcp'
                        ? '原生 TCP 协议（LZ4 压缩，性能更好）；端口通常 9000，明文连接（暂不支持 TLS）'
                        : 'HTTP 协议（端口通常 8123），兼容性最好'}
                    </span>
                  </div>
                </div>
              )}

              {/* MongoDB 专属：数据库 + authSource */}
              {isMongodb && (
                <>
                  <div className="dbf-row">
                    <span className="dbf-label">数据库 <span className="field-hint">可选</span></span>
                    <div className="dbf-val">
                      <input placeholder="留空则连接到默认库"
                        value={form.database ?? ''}
                        onChange={e => patch('database', e.target.value)}
                        spellCheck={false} autoComplete="off" />
                    </div>
                  </div>
                  <div className="dbf-row">
                    <span className="dbf-label">authSource <span className="field-hint">认证库</span></span>
                    <div className="dbf-val">
                      <input placeholder="admin（默认）"
                        value={extra.mongoAuthSource ?? ''}
                        onChange={e => patchExtra({ mongoAuthSource: e.target.value })}
                        spellCheck={false} autoComplete="off" />
                    </div>
                  </div>
                </>
              )}

              {/* PostgreSQL 专属：search_path + application_name */}
              {isPg && (
                <>
                  <div className="dbf-row">
                    <span className="dbf-label">search_path <span className="field-hint">可选，逗号分隔</span></span>
                    <div className="dbf-val">
                      <input placeholder="public, myschema（留空使用数据库默认）"
                        value={extra.pgSearchPath}
                        onChange={e => patchExtra({ pgSearchPath: e.target.value })}
                        spellCheck={false} autoComplete="off" />
                    </div>
                  </div>
                  <div className="dbf-row">
                    <span className="dbf-label">application_name</span>
                    <div className="dbf-val">
                      <input placeholder="DBTerm（默认）"
                        value={extra.pgAppName}
                        onChange={e => patchExtra({ pgAppName: e.target.value })}
                        spellCheck={false} autoComplete="off" />
                      <span className="field-hint" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        在 pg_stat_activity 中显示；留空默认为 "DBTerm"
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* SQL Server 专属：命名实例 / 加密 / 证书 / ApplicationIntent */}
              {isSqlServer && (
                <>
                  <div className="dbf-row">
                    <span className="dbf-label">命名实例 <span className="field-hint">可选</span></span>
                    <div className="dbf-val">
                      <input
                        placeholder="SQLEXPRESS（留空连默认实例）"
                        value={extra.ssInstance ?? ''}
                        onChange={e => patchExtra({ ssInstance: e.target.value })}
                        spellCheck={false} autoComplete="off" />
                      <span className="field-hint" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        等同于连接字符串中的 Server=主机\实例名
                      </span>
                    </div>
                  </div>
                  <div className="dbf-row">
                    <span className="dbf-label">连接安全</span>
                    <div className="dbf-val">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={extra.ssEncrypt ?? true}
                            onChange={e => patchExtra({ ssEncrypt: e.target.checked })} />
                          <span>强制加密（Encrypt=true）</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>SQL Server 2022 默认必须加密</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={extra.ssTrustCert ?? true}
                            onChange={e => patchExtra({ ssTrustCert: e.target.checked })} />
                          <span>信任服务器证书（TrustServerCertificate=true）</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>测试/内网可开启；生产建议关闭并配置证书</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <div className="dbf-row">
                    <span className="dbf-label">连接意向</span>
                    <div className="dbf-val">
                      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ss-app-intent" value="ReadWrite"
                            checked={(extra.ssAppIntent ?? 'ReadWrite') === 'ReadWrite'}
                            onChange={() => patchExtra({ ssAppIntent: 'ReadWrite' })} />
                          ReadWrite（默认）
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ss-app-intent" value="ReadOnly"
                            checked={extra.ssAppIntent === 'ReadOnly'}
                            onChange={() => patchExtra({ ssAppIntent: 'ReadOnly' })} />
                          ReadOnly（路由到 AG 只读副本）
                        </label>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>ApplicationIntent，读写意向影响 AG 可用性组路由</span>
                    </div>
                  </div>
                </>
              )}

              {/* Oracle 专属：连接模式 / 角色 / Schema */}
              {isOracle && (
                <>
                  <div className="dbf-row">
                    <span className="dbf-label">连接模式</span>
                    <div className="dbf-val">
                      <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-conn-mode" value="service"
                            checked={(extra.oraConnMode ?? 'service') === 'service'}
                            onChange={() => patchExtra({ oraConnMode: 'service' })} />
                          Service Name（推荐）
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-conn-mode" value="sid"
                            checked={extra.oraConnMode === 'sid'}
                            onChange={() => patchExtra({ oraConnMode: 'sid' })} />
                          SID（传统）
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-conn-mode" value="tns"
                            checked={extra.oraConnMode === 'tns'}
                            onChange={() => patchExtra({ oraConnMode: 'tns' })} />
                          TNS 别名
                        </label>
                      </div>
                      {(extra.oraConnMode ?? 'service') === 'service' && (
                        <>
                          <input className={errors.oraServiceName ? 'error' : ''}
                            placeholder="orcl 或 XEPDB1"
                            value={extra.oraServiceName}
                            onChange={e => patchExtra({ oraServiceName: e.target.value })}
                            spellCheck={false} autoComplete="off" />
                          {errors.oraServiceName && <span className="field-err">{errors.oraServiceName}</span>}
                        </>
                      )}
                      {extra.oraConnMode === 'sid' && (
                        <>
                          <input className={errors.oraSid ? 'error' : ''}
                            placeholder="ORCL"
                            value={extra.oraSid}
                            onChange={e => patchExtra({ oraSid: e.target.value })}
                            spellCheck={false} autoComplete="off" />
                          {errors.oraSid && <span className="field-err">{errors.oraSid}</span>}
                        </>
                      )}
                      {extra.oraConnMode === 'tns' && (
                        <>
                          <input className={errors.oraTnsAlias ? 'error' : ''}
                            placeholder="mydb（tnsnames.ora 中的别名）"
                            value={extra.oraTnsAlias}
                            onChange={e => patchExtra({ oraTnsAlias: e.target.value })}
                            spellCheck={false} autoComplete="off" />
                          {errors.oraTnsAlias && <span className="field-err">{errors.oraTnsAlias}</span>}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="dbf-row">
                    <span className="dbf-label">登录角色</span>
                    <div className="dbf-val">
                      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-role" value="default"
                            checked={(extra.oraRole ?? 'default') === 'default'}
                            onChange={() => patchExtra({ oraRole: 'default' })} />
                          普通用户
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-role" value="sysdba"
                            checked={extra.oraRole === 'sysdba'}
                            onChange={() => patchExtra({ oraRole: 'sysdba' })} />
                          SYSDBA
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="radio" name="ora-role" value="sysoper"
                            checked={extra.oraRole === 'sysoper'}
                            onChange={() => patchExtra({ oraRole: 'sysoper' })} />
                          SYSOPER
                        </label>
                      </div>
                    </div>
                  </div>
                  <div className="dbf-row dbf-row--flags">
                    <span className="dbf-label">Schema</span>
                    <div className="dbf-val">
                      <input placeholder="留空则使用登录用户 schema（可选）"
                        value={extra.oraSchema}
                        onChange={e => patchExtra({ oraSchema: e.target.value })}
                        spellCheck={false} autoComplete="off" />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        连接后自动执行 ALTER SESSION SET CURRENT_SCHEMA
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* URL 参数 */}
              <div className="dbf-row">
                <span className="dbf-label">URL 参数</span>
                <div className="dbf-val">
                  <input placeholder="charset=utf8mb4&connect_timeout=10"
                    value={extra.urlParams}
                    onChange={e => patchExtra({ urlParams: e.target.value })}
                    spellCheck={false} autoComplete="off" />
                </div>
              </div>

              {/* 环境标签（含「生产」——生产环境会在写操作前显示警告） */}
              <div className="dbf-row">
                <span className="dbf-label">环境标签</span>
                <div className="dbf-val">
                  <SearchableSelect
                    value={form.envLabel ?? ''}
                    onChange={v => patch('envLabel', (v as any) || null)}
                    placeholder="无"
                    items={[
                      { value: '', label: '无' },
                      { value: 'prod', label: '生产' },
                      { value: 'staging', label: '预发' },
                      { value: 'test', label: '测试' },
                    ]}
                    mono={false} />
                </div>
              </div>

              {/* 只读模式（ConnConfig 级别） */}
              <div className="dbf-row">
                <span className="dbf-label">只读模式</span>
                <div className="dbf-val" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={form.readonly ?? false}
                    onChange={e => patch('readonly', e.target.checked)} />
                  <span className="cf-hint" style={{ fontSize: 12, color: 'var(--text-muted)' }}>只读模式下禁止执行写操作</span>
                </div>
              </div>
            </>)}

          </div>
        )}

        {/* ── SSL / TLS ── */}
        {tab === 'ssl' && (
          <div className="form-grid">
            <div className="form-field full">
              <label>SSL 模式</label>
              <div className="ssl-mode-grid" style={{ marginTop: 6 }}>
                {SSL_MODES.map(m => (
                  <button key={m.value}
                    className={`ssl-mode-card${extra.sslMode === m.value ? ' active' : ''}`}
                    onClick={() => patchExtra({ sslMode: m.value })}>
                    <span className="ssl-mode-card__label">{m.label}</span>
                    <span className="ssl-mode-card__desc">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {extra.sslMode !== 'disabled' ? (<>
              <div className="form-field full">
                <label>CA 证书 <span className="field-hint">服务端证书链 / CA bundle</span></label>
                <div className="input-addon">
                  <input placeholder="/path/to/ca.pem（留空使用系统 CA）" value={extra.sslCa}
                    onChange={e => patchExtra({ sslCa: e.target.value })} />
                  <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patchExtra({ sslCa: v }), '选择 CA 证书')}><FolderOpen size={14} /></button>
                </div>
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>客户端证书 <span className="field-hint">双向认证时需要</span></label>
                <div className="input-addon">
                  <input placeholder="/path/to/client-cert.pem" value={extra.sslCert}
                    onChange={e => patchExtra({ sslCert: e.target.value })} />
                  <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patchExtra({ sslCert: v }), '选择客户端证书')}><FolderOpen size={14} /></button>
                </div>
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>客户端私钥</label>
                <div className="input-addon">
                  <input placeholder="/path/to/client-key.pem" value={extra.sslKey}
                    onChange={e => patchExtra({ sslKey: e.target.value })} />
                  <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patchExtra({ sslKey: v }), '选择客户端私钥')}><FolderOpen size={14} /></button>
                </div>
              </div>
              <div className="form-field full" style={{ marginTop: 0 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  证书路径支持 <code style={{ fontSize: 11 }}>~</code> 展开。客户端证书/私钥仅在服务端要求双向 TLS 时填写，一般留空即可。
                </p>
              </div>
            </>) : (
              <div className="form-field full">
                <div className="db-empty-tip">
                  <span>SSL/TLS 已禁用，连接数据将明文传输</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    生产环境建议至少选择「需要」
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SSH 隧道 ── */}
        {tab === 'tunnel' && (
          <div className="form-grid">
            {/* 启用开关 */}
            <div className="form-field full">
              <div className="db-toggle-row">
                <div>
                  <div className="db-toggle-title">启用 SSH 隧道</div>
                  <div className="db-toggle-desc">先通过 SSH 服务器建立加密通道，再访问目标数据库</div>
                </div>
                <label className="adv-toggle" style={{ marginBottom: 0 }}>
                  <span className="toggle-sw">
                    <input type="checkbox" checked={extra.sshTunnel}
                      onChange={e => patchExtra({ sshTunnel: e.target.checked })} />
                    <span className="toggle-track" />
                  </span>
                </label>
              </div>
            </div>

            {extra.sshTunnel && (<>
              {/* 主机 + 端口 */}
              <div className="form-field full db-row">
                <div className="form-field" style={{ flex: 4, margin: 0, gap: 5 }}>
                  <label>SSH 主机</label>
                  <input placeholder="jump.example.com" value={extra.sshHost}
                    onChange={e => patchExtra({ sshHost: e.target.value })} />
                </div>
                <div className="form-field" style={{ flex: 1, minWidth: 80, margin: 0, gap: 5 }}>
                  <label>SSH 端口</label>
                  <input type="number" value={extra.sshPort}
                    onChange={e => patchExtra({ sshPort: Number(e.target.value) || 22 })} />
                </div>
              </div>

              {/* 认证方式 — 5 选项 */}
              <div className="form-field full">
                <label>认证方式</label>
                <div className="auth-seg">
                  {([
                    ['password', '密码'],
                    ['key',      '私钥'],
                    ['mfa',      'MFA / 2FA'],
                    ['agent',    'SSH Agent'],
                    ['none',     '不验证'],
                  ] as const).map(([v, label]) => (
                    <button key={v}
                      className={`auth-seg-btn${extra.sshAuthType === v ? ' active' : ''}`}
                      onClick={() => patchExtra({ sshAuthType: v })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 用户名 + 密码/私钥 同行 */}
              <div className="form-field full db-row">
                <div className="form-field" style={{ flex: 1, margin: 0, gap: 5 }}>
                  <label>用户名</label>
                  <input value={extra.sshUser}
                    onChange={e => patchExtra({ sshUser: e.target.value })} autoComplete="off" />
                </div>
                {(extra.sshAuthType === 'password' || extra.sshAuthType === 'mfa') && (
                  <div className="form-field" style={{ flex: 1, margin: 0, gap: 5 }}>
                    <label>{extra.sshAuthType === 'mfa' ? '密码 / 第一因素' : '密码'}</label>
                    <div className="input-addon">
                      <input type={showSshPwd ? 'text' : 'password'} value={extra.sshPassword}
                        onChange={e => patchExtra({ sshPassword: e.target.value })}
                        autoComplete="new-password" />
                      <button className="addon-btn" onClick={() => setShowSshPwd(v => !v)}>
                        {showSshPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                )}
                {extra.sshAuthType === 'key' && (
                  <div className="form-field" style={{ flex: 1, margin: 0, gap: 5 }}>
                    <label>私钥路径</label>
                    <div className="input-addon">
                      <input placeholder="~/.ssh/id_ed25519" value={extra.sshKeyPath}
                        onChange={e => patchExtra({ sshKeyPath: e.target.value })} />
                      <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patchExtra({ sshKeyPath: v }), '选择 SSH 私钥')}><FolderOpen size={14} /></button>
                    </div>
                  </div>
                )}
              </div>

              {extra.sshAuthType === 'agent' && (
                <div className="form-field full">
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    将使用本地 SSH Agent（ssh-agent）中的密钥认证，无需手动填写密码或私钥路径。
                  </p>
                </div>
              )}
              {extra.sshAuthType === 'none' && (
                <div className="form-field full">
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--warning)', lineHeight: 1.6 }}>
                    不验证模式：服务器允许匿名登录时才可用，生产环境请勿使用。
                  </p>
                </div>
              )}

              <div className="form-field full" style={{ marginTop: 0 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                  隧道建立后，DBTerm 会将数据库流量从本地随机端口转发至 <strong>{form.host || '目标主机'}:{form.port}</strong>
                </p>
              </div>
            </>)}

            {!extra.sshTunnel && (
              <div className="form-field full">
                <div className="db-empty-tip">
                  <span>SSH 隧道未启用</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    适用于数据库端口未直接对外开放、需要通过跳板机中转的场景
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 高级 ── */}
        {tab === 'advanced' && (
          <div className="form-grid">
            {/* 连接超时 + 字符编码 */}
            <div className="form-field" style={{ flex: 1 }}>
              <label>连接超时 <span className="field-hint">秒，0 = 不限</span></label>
              <input type="number" min={0} max={300} value={extra.connectTimeout}
                onChange={e => patchExtra({ connectTimeout: Number(e.target.value) })} />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>连接字符集</label>
              <SearchableSelect
                value={extra.encoding}
                onChange={v => patchExtra({ encoding: v })}
                options={['UTF-8','GBK','GB2312','Latin-1']}
                mono={false} />
            </div>

            {/* 初始化 SQL */}
            <div className="form-field full">
              <label>初始化 SQL <span className="field-hint">每次连接成功后自动执行</span></label>
              <textarea className="cf-textarea" rows={4}
                placeholder={'-- 可在此设置会话级参数，例如：\nSET time_zone = \'+08:00\';\nSET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;'}
                value={extra.initSql}
                onChange={e => patchExtra({ initSql: e.target.value })} />
            </div>

            {/* 备注 */}
            <div className="form-field full">
              <label>备注</label>
              <textarea className="cf-textarea" rows={2} placeholder="可选备注（仅本地展示）"
                value={extra.note}
                onChange={e => patchExtra({ note: e.target.value })} />
            </div>
          </div>
        )}

        {/* ── 驱动管理（仅显示当前连接类型所需驱动）── */}
        {tab === 'drivers' && (
          <DriverManager filterType={CONN_DRIVER_MAP[selType]} />
        )}
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════════
// SSH Form (5 tabs)
// ════════════════════════════════════════════════════════════════

type SshTab = 'standard' | 'tunnel' | 'proxy' | 'env' | 'advanced'
const SSH_TABS: { id: SshTab; label: string }[] = [
  { id: 'standard', label: '标准' },
  { id: 'tunnel',   label: '隧道' },
  { id: 'proxy',    label: '代理' },
  { id: 'env',      label: '环境变量' },
  { id: 'advanced', label: '高级' },
]

interface SshFormProps {
  form: ConnConfig; patch: (k: keyof ConnConfig, v: unknown) => void
  password: string; setPassword: (s: string) => void
  showPwd: boolean
  extra: SshExtra; patchExtra: (u: Partial<SshExtra>) => void
  errors: Record<string, string>
  pwdEditing: boolean
  passwordLoaded: boolean; onTogglePwd: () => void
}

const AUTH_OPTS: { value: SshExtra['authType']; label: string }[] = [
  { value: 'password', label: '密码' },
  { value: 'key',      label: '私钥' },
  { value: 'mfa',      label: 'MFA / 2FA' },
  { value: 'agent',    label: 'SSH Agent' },
  { value: 'none',     label: '不验证' },
]

function SshForm({ form, patch, password, setPassword, showPwd, extra, patchExtra, errors, pwdEditing, passwordLoaded, onTogglePwd }: SshFormProps) {
  const [tab, setTab] = useState<SshTab>('standard')
  const [showJumpPwd, setShowJumpPwd] = useState(false)

  return (
    <>
      {/* Tab bar */}
      <div className="cf-tab-bar">
        {SSH_TABS.map(t => (
          <button key={t.id} className={`cf-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="modal-body cf-pane">

        {/* ── 标准 ── */}
        {tab === 'standard' && (
          <div className="form-grid">
            {/* 名称 (inline color swatches) */}
            <div className="form-field full">
              <label>名称</label>
              <div className="cf-name-row">
                <input className={errors.name ? 'error' : ''} placeholder="SSH 连接"
                  value={form.name} onChange={e => patch('name', e.target.value)} />
                <div className="cf-color-swatches" data-tip="颜色标签（点击选中，再点取消）">
                  {COLORS.map(c => (
                    <button key={c} className={`color-swatch${form.color === c ? ' sel' : ''}`}
                      style={{ background: c }} onClick={() => patch('color', form.color === c ? '' : c)} />
                  ))}
                </div>
              </div>
              {errors.name && <span className="field-err">{errors.name}</span>}
            </div>

            {/* Host + 端口 */}
            <div className="form-field" style={{ flex: 3 }}>
              <label>主机地址</label>
              <input className={errors.host ? 'error' : ''} placeholder="192.168.1.1"
                value={form.host ?? ''} onChange={e => patch('host', e.target.value)} />
              {errors.host && <span className="field-err">{errors.host}</span>}
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>端口</label>
              <input type="number" value={form.port ?? 22}
                onChange={e => patch('port', Number(e.target.value))} />
            </div>

            {/* 认证方式 — segmented control */}
            <div className="form-field full">
              <label>认证方式</label>
              <div className="auth-seg">
                {AUTH_OPTS.map(o => (
                  <button key={o.value}
                    className={`auth-seg-btn${extra.authType === o.value ? ' active' : ''}`}
                    onClick={() => patchExtra({ authType: o.value })}>{o.label}</button>
                ))}
              </div>
            </div>

            {/* 用户名 + 凭据 同行 */}
            <div className="form-field" style={{ flex: 1 }}>
              <label>用户名</label>
              <input value={form.username ?? 'root'} onChange={e => patch('username', e.target.value)} />
            </div>

            {(extra.authType === 'password' || extra.authType === 'mfa') && (
              <div className="form-field" style={{ flex: 1.4 }}>
                <label>密码</label>
                {!pwdEditing ? (
                  <div className="input-addon">
                    <input type="password" value="••••••••" readOnly
                      style={{ cursor: 'default', color: 'var(--text-3)' }} />
                    <button className="addon-btn" onClick={onTogglePwd} data-tip="显示已保存密码">
                      <Eye size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="input-addon">
                    <input type={showPwd ? 'text' : 'password'} value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoComplete="new-password" placeholder="输入新密码" autoFocus />
                    <button className="addon-btn" onClick={onTogglePwd} data-tip={showPwd ? '隐藏密码' : (passwordLoaded ? '显示密码' : '读取并显示已保存密码')}>
                      {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )}
              </div>
            )}

            {extra.authType === 'key' && (<>
              <div className="form-field" style={{ flex: 1.4 }}>
                <label>私钥路径</label>
                <div className="input-addon">
                  <input placeholder="~/.ssh/id_ed25519" value={form.sshKeyPath ?? ''}
                    onChange={e => patch('sshKeyPath', e.target.value || undefined)} />
                  <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patch('sshKeyPath', v || undefined), '选择 SSH 私钥')}><FolderOpen size={14} /></button>
                </div>
              </div>
              {/* 密钥口令（加密私钥需要；无口令留空）。与密码共用 keychain 槽，后端用作 passphrase */}
              <div className="form-field" style={{ flex: 1 }}>
                <label>密钥口令</label>
                {!pwdEditing ? (
                  <div className="input-addon">
                    <input type="password" value="••••••••" readOnly
                      style={{ cursor: 'default', color: 'var(--text-3)' }} />
                    <button className="addon-btn" onClick={onTogglePwd} data-tip="显示已保存密钥口令">
                      <Eye size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="input-addon">
                    <input type={showPwd ? 'text' : 'password'} value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoComplete="new-password" placeholder="无口令留空" />
                    <button className="addon-btn" onClick={onTogglePwd} data-tip={showPwd ? '隐藏密钥口令' : (passwordLoaded ? '显示密钥口令' : '读取并显示已保存密钥口令')}>
                      {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )}
              </div>
            </>)}

            {/* 备注 */}
            <div className="form-field full">
              <label>备注</label>
              <textarea className="cf-textarea" rows={2} placeholder="可选备注信息"
                value={extra.note} onChange={e => patchExtra({ note: e.target.value })} />
            </div>

            {/* ── 跳板机 ── */}
            <div className="form-field full">
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>跳板机 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>ProxyJump</span></span>
                <label className="adv-toggle" style={{ marginBottom: 0 }}>
                  <span style={{ display: 'none' }} />
                  <span className="toggle-sw">
                    <input type="checkbox" checked={extra.jumpEnabled}
                      onChange={e => patchExtra({ jumpEnabled: e.target.checked })} />
                    <span className="toggle-track" />
                  </span>
                </label>
              </label>
            </div>

            {extra.jumpEnabled && (<>
              <div className="form-field" style={{ flex: 3 }}>
                <label>跳板机地址</label>
                <input placeholder="jump.example.com" value={extra.jumpHost}
                  onChange={e => patchExtra({ jumpHost: e.target.value })} />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>端口</label>
                <input type="number" value={extra.jumpPort}
                  onChange={e => patchExtra({ jumpPort: Number(e.target.value) })} />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>用户名</label>
                <input value={extra.jumpUsername}
                  onChange={e => patchExtra({ jumpUsername: e.target.value })} autoComplete="off" />
              </div>
              <div className="form-field full">
                <label>认证方式</label>
                <div className="auth-seg">
                  {(['password', 'key', 'agent'] as const).map(v => (
                    <button key={v}
                      className={`auth-seg-btn${extra.jumpAuthType === v ? ' active' : ''}`}
                      onClick={() => patchExtra({ jumpAuthType: v })}>
                      {v === 'password' ? '密码' : v === 'key' ? '私钥' : 'SSH Agent'}
                    </button>
                  ))}
                </div>
              </div>
              {extra.jumpAuthType === 'password' && (
                <div className="form-field" style={{ flex: 1 }}>
                  <label>密码</label>
                  <div className="input-addon">
                    <input type={showJumpPwd ? 'text' : 'password'} value={extra.jumpPassword}
                      onChange={e => patchExtra({ jumpPassword: e.target.value })}
                      autoComplete="new-password" placeholder="跳板机密码（留空保持不变）" />
                    <button className="addon-btn" onClick={() => setShowJumpPwd(v => !v)}>
                      {showJumpPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}
              {extra.jumpAuthType === 'key' && (<>
                <div className="form-field" style={{ flex: 2 }}>
                  <label>私钥路径</label>
                  <div className="input-addon">
                    <input placeholder="~/.ssh/id_ed25519" value={extra.jumpKeyPath}
                      onChange={e => patchExtra({ jumpKeyPath: e.target.value })} />
                    <button className="addon-btn" data-tip="浏览文件" onClick={() => pickFile(v => patchExtra({ jumpKeyPath: v }), '选择跳板机私钥')}><FolderOpen size={14} /></button>
                  </div>
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label>密钥口令</label>
                  <input type="password" value={extra.jumpPassword}
                    onChange={e => patchExtra({ jumpPassword: e.target.value })}
                    placeholder="无口令留空" autoComplete="new-password" />
                </div>
              </>)}

              {/* ── 额外跳板（多跳链）── */}
              {extra.extraJumps.map((hop, idx) => {
                const patchHop = (patch: Partial<ExtraJump>) => {
                  const jumps = [...extra.extraJumps]
                  jumps[idx] = { ...jumps[idx], ...patch }
                  patchExtra({ extraJumps: jumps })
                }
                return (
                  <div key={idx} className="form-field full" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>跳板 {idx + 2}</span>
                      <button className="cf-row-del" onClick={() => patchExtra({ extraJumps: extra.extraJumps.filter((_, i) => i !== idx) })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <div className="form-field" style={{ flex: 3, margin: 0 }}>
                        <label>地址</label>
                        <input placeholder="hop2.example.com" value={hop.host}
                          onChange={e => patchHop({ host: e.target.value })} />
                      </div>
                      <div className="form-field" style={{ flex: 1, margin: 0 }}>
                        <label>端口</label>
                        <input type="number" value={hop.port}
                          onChange={e => patchHop({ port: Number(e.target.value) })} />
                      </div>
                      <div className="form-field" style={{ flex: 1, margin: 0 }}>
                        <label>用户名</label>
                        <input value={hop.username}
                          onChange={e => patchHop({ username: e.target.value })} autoComplete="off" />
                      </div>
                      <div className="form-field full" style={{ margin: 0 }}>
                        <label>认证方式</label>
                        <div className="auth-seg">
                          {(['password', 'key', 'agent'] as const).map(v => (
                            <button key={v}
                              className={`auth-seg-btn${hop.authType === v ? ' active' : ''}`}
                              onClick={() => patchHop({ authType: v })}>
                              {v === 'password' ? '密码' : v === 'key' ? '私钥' : 'SSH Agent'}
                            </button>
                          ))}
                        </div>
                      </div>
                      {hop.authType === 'password' && (
                        <div className="form-field" style={{ flex: 1, margin: 0 }}>
                          <label>密码</label>
                          <input type="password" value={hop.password}
                            onChange={e => patchHop({ password: e.target.value })}
                            autoComplete="new-password" placeholder="留空保持不变" />
                        </div>
                      )}
                      {hop.authType === 'key' && (<>
                        <div className="form-field" style={{ flex: 2, margin: 0 }}>
                          <label>私钥路径</label>
                          <div className="input-addon">
                            <input placeholder="~/.ssh/id_ed25519" value={hop.keyPath}
                              onChange={e => patchHop({ keyPath: e.target.value })} />
                            <button className="addon-btn" data-tip="浏览文件"
                              onClick={() => pickFile(v => patchHop({ keyPath: v }), `选择跳板 ${idx + 2} 私钥`)}>
                              <FolderOpen size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="form-field" style={{ flex: 1, margin: 0 }}>
                          <label>密钥口令</label>
                          <input type="password" value={hop.password}
                            onChange={e => patchHop({ password: e.target.value })}
                            placeholder="无口令留空" autoComplete="new-password" />
                        </div>
                      </>)}
                    </div>
                  </div>
                )
              })}
              <div className="form-field full" style={{ marginTop: 4 }}>
                <button className="cf-add-row-btn" onClick={() => patchExtra({
                  extraJumps: [...extra.extraJumps, { host: '', port: 22, username: '', authType: 'password', keyPath: '', password: '' }]
                })}>
                  <Plus size={13} /> 添加跳板
                </button>
              </div>
            </>)}
          </div>
        )}

        {/* ── 隧道 ── */}
        {tab === 'tunnel' && (
          <div className="cf-table-section">
            <div className="cf-table-header">
              <div style={{ flex: 2 }}>名称</div>
              <div style={{ flex: 1 }}>类型</div>
              <div style={{ flex: 2 }}>绑定 IP</div>
              <div style={{ flex: 1 }}>绑定端口</div>
              <div style={{ flex: 2 }}>目标 IP</div>
              <div style={{ flex: 1 }}>目标端口</div>
              <div style={{ width: 60 }}>操作</div>
            </div>
            {extra.tunnels.length === 0 ? (
              <div className="cf-empty">
                <div className="cf-empty__icon">⛅</div>
                <div>暂无隧道配置</div>
              </div>
            ) : extra.tunnels.map((t) => (
              <div key={t.id} className="cf-table-row">
                <div style={{ flex: 2 }}><input value={t.name} onChange={e => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, name: e.target.value } : r) })} /></div>
                <div style={{ flex: 1 }}>
                  <SearchableSelect value={t.type} onChange={v => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, type: v as SshTunnel['type'] } : r) })}
                    items={[
                      { value: 'local', label: '本地' },
                      { value: 'remote', label: '远程' },
                      { value: 'dynamic', label: '动态' },
                    ]}
                    mono={false} />
                </div>
                <div style={{ flex: 2 }}><input value={t.bindIP} onChange={e => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, bindIP: e.target.value } : r) })} /></div>
                <div style={{ flex: 1 }}><input type="number" value={t.bindPort} onChange={e => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, bindPort: Number(e.target.value) } : r) })} /></div>
                <div style={{ flex: 2 }}><input value={t.targetIP} onChange={e => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, targetIP: e.target.value } : r) })} /></div>
                <div style={{ flex: 1 }}><input type="number" value={t.targetPort} onChange={e => patchExtra({ tunnels: extra.tunnels.map(r => r.id === t.id ? { ...r, targetPort: Number(e.target.value) } : r) })} /></div>
                <div style={{ width: 60, display: 'flex', justifyContent: 'center' }}>
                  <button className="cf-row-del" onClick={() => patchExtra({ tunnels: extra.tunnels.filter(r => r.id !== t.id) })}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
            <button className="cf-add-btn" onClick={() => patchExtra({ tunnels: [...extra.tunnels, { id: `t-${Date.now()}`, name: '新隧道', type: 'local', bindIP: '127.0.0.1', bindPort: 8080, targetIP: '127.0.0.1', targetPort: 80, disabled: false }] })}>
              <Plus size={13} /> 添加隧道
            </button>
          </div>
        )}

        {/* ── 代理 ── */}
        {tab === 'proxy' && (
          <div className="form-grid">
            <div className="form-field" style={{ flex: 1 }}>
              <label>代理方式</label>
              <SearchableSelect value={extra.proxyType}
                onChange={v => patchExtra({ proxyType: v as SshExtra['proxyType'] })}
                items={[
                  { value: 'none', label: '关闭' },
                  { value: 'http', label: 'HTTP' },
                  { value: 'socks5', label: 'SOCKS5' },
                ]}
                mono={false} />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>连接超时（秒）</label>
              <input type="number" value={extra.proxyTimeout}
                onChange={e => patchExtra({ proxyTimeout: Number(e.target.value) })} />
            </div>
            {extra.proxyType !== 'none' && (<>
              <div className="form-field" style={{ flex: 2 }}>
                <label>Host</label>
                <input value={extra.proxyHost} onChange={e => patchExtra({ proxyHost: e.target.value })} />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>端口</label>
                <input type="number" value={extra.proxyPort}
                  onChange={e => patchExtra({ proxyPort: Number(e.target.value) })} />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>账号</label>
                <input value={extra.proxyUsername}
                  onChange={e => patchExtra({ proxyUsername: e.target.value })} autoComplete="off" />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>密码</label>
                <div className="input-addon">
                  <input type="password" value={extra.proxyPassword}
                    onChange={e => patchExtra({ proxyPassword: e.target.value })}
                    autoComplete="new-password" placeholder="代理密码（留空保持不变）" />
                  <button className="addon-btn"><Eye size={14} /></button>
                </div>
              </div>
            </>)}
          </div>
        )}

        {/* ── 环境变量 ── */}
        {tab === 'env' && (
          <div className="cf-table-section">
            <div className="cf-table-header">
              <div style={{ flex: 1 }}>名称 ⓘ</div>
              <div style={{ flex: 2 }}>值</div>
              <div style={{ width: 40 }} />
            </div>
            {extra.envVars.length === 0 ? (
              <div className="cf-empty">
                <div className="cf-empty__icon">⛅</div>
                <div>暂无环境变量</div>
              </div>
            ) : extra.envVars.map(v => (
              <div key={v.id} className="cf-table-row">
                <div style={{ flex: 1 }}><input value={v.name} onChange={e => patchExtra({ envVars: extra.envVars.map(r => r.id === v.id ? { ...r, name: e.target.value } : r) })} /></div>
                <div style={{ flex: 2 }}><input value={v.value} onChange={e => patchExtra({ envVars: extra.envVars.map(r => r.id === v.id ? { ...r, value: e.target.value } : r) })} /></div>
                <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                  <button className="cf-row-del" onClick={() => patchExtra({ envVars: extra.envVars.filter(r => r.id !== v.id) })}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
            <button className="cf-add-btn" onClick={() => patchExtra({ envVars: [...extra.envVars, { id: `e-${Date.now()}`, name: '', value: '' }] })}>
              <Plus size={13} /> 添加变量
            </button>
          </div>
        )}

        {/* ── 高级 ── */}
        {tab === 'advanced' && (
          <div className="form-grid">
            <div className="form-field full">
              <label>功能开关</label>
              <div className="adv-toggles">
                {([
                  ['enableSftp',        '启用 SFTP',  '文件管理走 SFTP 协议（推荐）'],
                  ['sftpSudo',          'SFTP-SUDO',  '以 sudo 启动 sftp-server，可管理 root 文件'],
                  ['enableCompression', '传输压缩',    'zlib 压缩，慢速链路提速'],
                  ['recordLog',         '录制日志',    '会话输出落盘到 logs 目录'],
                  ['agentForwarding',   'Agent 转发',  '将本地 SSH Agent 转发到远端，支持免密二次跳转'],
                ] as [keyof SshExtra, string, string][]).map(([k, l, hint]) => (
                  <label key={k} className="adv-toggle" title={hint}>
                    <span>{l}</span>
                    <span className="toggle-sw">
                      <input type="checkbox" checked={extra[k] as boolean}
                        onChange={e => patchExtra({ [k]: e.target.checked })} />
                      <span className="toggle-track" />
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* 安全 */}
            <div className="form-field full">
              <label>安全</label>
              <div className="adv-fields-grid">
                <div className="form-field">
                  <label>主机密钥校验</label>
                  <SearchableSelect value={extra.hostKeyPolicy}
                    onChange={v => patchExtra({ hostKeyPolicy: v as SshExtra['hostKeyPolicy'] })}
                    items={[
                      { value: 'tofu', label: '首次信任 (TOFU)' },
                      { value: 'strict', label: '严格校验（仅信任已知主机）' },
                      { value: 'skip', label: '跳过校验（不安全）' },
                    ]}
                    mono={false} />
                </div>
                <div className="form-field">
                  <label>空闲自动断开（分钟）</label>
                  <input type="number" min={0} placeholder="0 = 不断开" value={extra.idleTimeoutMinutes}
                    onChange={e => patchExtra({ idleTimeoutMinutes: Math.max(0, Number(e.target.value) || 0) })} />
                </div>
                <div className="form-field">
                  <label>连接超时（秒）</label>
                  <input type="number" value={extra.connectTimeout}
                    onChange={e => patchExtra({ connectTimeout: Number(e.target.value) })} />
                </div>
              </div>
            </div>

            {/* 终端 */}
            <div className="form-field full">
              <label>终端</label>
              <div className="adv-fields-grid">
                <div className="form-field">
                  <label>编码</label>
                  <SearchableSelect value={extra.encoding}
                    onChange={v => patchExtra({ encoding: v })}
                    options={['UTF-8','GBK','GB2312','Latin-1']}
                    mono={false} />
                </div>
                <div className="form-field">
                  <label>终端类型</label>
                  <SearchableSelect value={extra.terminalType}
                    onChange={v => patchExtra({ terminalType: v })}
                    options={['xterm-256color','xterm','vt100','vt220','screen']}
                    mono={false} />
                </div>
                <div className="form-field">
                  <label>心跳时间（秒）</label>
                  <input type="number" value={extra.heartbeatInterval}
                    onChange={e => patchExtra({ heartbeatInterval: Number(e.target.value) })} />
                </div>
              </div>
            </div>

            {/* SFTP */}
            <div className="form-field full">
              <label>SFTP</label>
              <div className="adv-fields-grid adv-fields-grid--2">
                <div className="form-field">
                  <label>默认路径</label>
                  <input placeholder="留空使用 $HOME" value={extra.sftpDefaultPath}
                    onChange={e => patchExtra({ sftpDefaultPath: e.target.value })} />
                </div>
                <div className="form-field">
                  <label>SUDO 启动命令</label>
                  <input value={extra.sftpCommand} onChange={e => patchExtra({ sftpCommand: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="form-field full">
              <label>初始执行命令</label>
              <textarea className="cf-textarea" rows={2} placeholder="连接成功后自动执行的命令"
                value={extra.initCommand} onChange={e => patchExtra({ initCommand: e.target.value })} />
            </div>
          </div>
        )}

      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════════
// Shell Picker
// ════════════════════════════════════════════════════════════════

interface ShellOption {
  id: string
  label: string
  enhanced?: boolean
}

const SHELL_OPTIONS: ShellOption[] = [
  { id: 'cmd',         label: 'cmd' },
  { id: 'bash',        label: 'bash',        enhanced: true },
  { id: 'powershell',  label: 'powershell' },
  { id: 'powershell7', label: 'powershell7' },
  { id: 'wsl',         label: 'wsl' },
  { id: 'zsh',         label: 'zsh',         enhanced: true },
  { id: 'fish',        label: 'fish' },
]

function ShellPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const triggerRef  = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const selected    = SHELL_OPTIONS.find(s => s.id === value)
  const open        = pos !== null

  function handleToggle() {
    if (open) { setPos(null); return }
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setPos({ top: r.bottom, left: r.left, width: r.width })
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      // 点在触发按钮或下拉面板内 → 不关闭
      if (triggerRef.current?.contains(t))  return
      if (dropdownRef.current?.contains(t)) return
      setPos(null)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setPos(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div style={{ marginTop: 8 }}>
      <button
        ref={triggerRef}
        type="button"
        className={`shell-trigger${open ? ' open' : ''}`}
        onClick={handleToggle}
      >
        <span className="shell-trigger__label">{selected?.label ?? '请选择 Shell'}</span>
        <svg className="shell-trigger__arrow" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          className="shell-dropdown"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          {SHELL_OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              className={`shell-option${value === opt.id ? ' selected' : ''}`}
              onClick={() => { onChange(opt.id); setPos(null) }}
            >
              <span>{opt.label}</span>
              {opt.enhanced && <span className="shell-enhanced">增强终端</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
