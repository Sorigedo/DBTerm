// Redis 浏览器主面板
// R0: 连接池 + 多 DB 切换 + 版本能力探测
// R1: 前缀树键列表 + 渐进式加载 + 安全删除
// R2: 全类型值编辑器入口
// R3: CLI 面板入口
// R4: 监控面板入口
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Search, RefreshCw, Loader2, Database, Plus,
  ChevronRight, ChevronDown, Layers,
  Copy, Pencil, Clock3, Trash2,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import ConfirmDialog from '../shared/ConfirmDialog'
import ValueEditor from './ValueEditor'
import NewKeyDialog from './NewKeyDialog'
import CliPanel from './CliPanel'
import InfoDashboard from './InfoDashboard'
import PubSubPanel from './PubSubPanel'
import ToolsPanel from './ToolsPanel'
import DbaPanel from './DbaPanel'
import { useRedisStore, type RedisKeyInfo, type RedisDbInfo, type RedisServerCaps } from '../../stores/redisStore'
import { useAppStore } from '../../stores/appStore'
import EnvWatermark from '../common/EnvWatermark'
import { useShortcuts } from '../../utils/useShortcuts'
import ContextMenu from '../ContextMenu'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcutStr, SHORTCUT_DEFS } from '../../utils/shortcuts'

type MainTab = 'browser' | 'cli' | 'monitor' | 'pubsub' | 'tools' | 'dba'

interface Props { connectionId: string; active?: boolean }

interface RedisScanResult { keys: RedisKeyInfo[]; cursor: number; hasMore: boolean }

// ── 前缀树节点 ───────────────────────────────────────────────────────────────
interface TreeNode {
  prefix: string       // 完整前缀（用于 SCAN MATCH）
  label: string        // 显示名称（去掉父前缀后的部分）
  keyCount: number     // 叶子 key 数
  children: Map<string, TreeNode>
  keys: RedisKeyInfo[] // 直接属于此节点的 key（叶子层）
  expanded: boolean
}

function buildPrefixTree(keys: RedisKeyInfo[], separator: string): Map<string, TreeNode> {
  const root = new Map<string, TreeNode>()
  for (const k of keys) {
    const parts = k.key.split(separator)
    let map = root
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join(separator) + separator
      const label = parts[i]
      if (!map.has(label)) {
        map.set(label, { prefix, label, keyCount: 0, children: new Map(), keys: [], expanded: false })
      }
      const node = map.get(label)!
      node.keyCount++
      map = node.children
    }
    // 叶子 key 挂在最后一级父节点上，或直接在 root（无分隔符的 key）
    if (parts.length === 1) {
      // 无前缀，直接挂在 root 虚拟节点上（用特殊 key "" 区分）
      if (!root.has('')) {
        root.set('', { prefix: '', label: '', keyCount: 0, children: new Map(), keys: [], expanded: true })
      }
      root.get('')!.keys.push(k)
    } else {
      const parentLabel = parts[parts.length - 2]
      // 找到父节点的正确 map
      let parentMap = root
      for (let i = 0; i < parts.length - 2; i++) {
        parentMap = parentMap.get(parts[i])?.children ?? new Map()
      }
      const parent = parentMap.get(parentLabel)
      if (parent) parent.keys.push(k)
    }
  }
  return root
}

// TTL 格式化
function fmtTtl(ttl: number): string {
  if (ttl === -1) return '永久'
  if (ttl < 0) return '—'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86400)}d`
}

const KIND_COLOR: Record<string, string> = {
  string: 'var(--accent)',
  list:   '#22c55e',
  hash:   '#f59e0b',
  set:    '#8b5cf6',
  zset:   '#ec4899',
  stream: '#06b6d4',
}

export default function RedisBrowser({ connectionId, active = true }: Props) {
  const { getCaps, getActiveDb, getDbList, setCaps, setActiveDb, setDbList } = useRedisStore()
  const redisConn = useAppStore(s => s.connections.find(c => c.id === connectionId))

  const caps = getCaps(connectionId)
  const activeDb = getActiveDb(connectionId)
  const dbList = getDbList(connectionId)

  const [mainTab,    setMainTab]   = useState<MainTab>('browser')
  const [pattern,    setPattern]   = useState('')
  const [allKeys,    setAllKeys]   = useState<RedisKeyInfo[]>([])
  const [cursor,     setCursor]    = useState(0)
  const [hasMore,    setHasMore]   = useState(false)
  const [loading,    setLoading]   = useState(false)
  const [error,      setError]     = useState('')
  const [selected,   setSelected]  = useState<string | null>(null)
  const [confirmDel, setConfirmDel]= useState<{ key: string; large?: boolean } | null>(null)
  const [deleting,   setDeleting]  = useState(false)
  const [delProgress, setDelProgress] = useState<number | null>(null)
  const [showNewKey, setShowNewKey]= useState(false)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [showDbPicker, setShowDbPicker] = useState(false)
  // R7.1 只读模式；R7.2 生产标识
  const [isReadonly, setIsReadonly] = useState(false)
  const [isProduction, setIsProduction] = useState(false)
  // KB4.2 外部触发 ValueEditor 的快捷键操作
  const [keyTrigger, setKeyTrigger] = useState<'rename' | 'ttl' | null>(null)
  // KB4.4 key 列表右键菜单
  const [keyCtxMenu, setKeyCtxMenu] = useState<{ x: number; y: number; key: string; kind: string } | null>(null)

  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const sc = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  const genRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // KB4 Redis 快捷键
  useShortcuts('redis', {
    redisSearch:  () => { if (mainTab === 'browser') { searchInputRef.current?.focus(); searchInputRef.current?.select() } },
    redisRefresh: () => { if (mainTab === 'browser') scan(pattern, 0, false) },
    redisNewKey:  () => { if (mainTab === 'browser') setShowNewKey(true) },
    redisRename:  () => { if (mainTab === 'browser' && selected) setKeyTrigger('rename') },
    redisTtlEdit: () => { if (mainTab === 'browser' && selected) setKeyTrigger('ttl') },
    redisDeleteKey:() => { if (mainTab === 'browser' && selected && !isReadonly) {
      const ki = allKeys.find(k => k.key === selected)
      const large = ki ? ['list','set','zset','hash','stream'].includes(ki.kind) : false
      setConfirmDel({ key: selected, large })
    }},
    redisCopyKey: () => { if (mainTab === 'browser' && selected) navigator.clipboard.writeText(selected).catch(() => {}) },
    redisFocusCli:() => { setMainTab('cli') },
  }, active)

  // ── 初始化：探测版本能力 ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const c = await invoke<RedisServerCaps>('redis_server_caps', { id: connectionId, db: activeDb })
        if (!cancelled) setCaps(connectionId, c)
      } catch (_) { /* 版本探测失败不影响主流程 */ }
      // 加载 DB 列表
      try {
        const list = await invoke<RedisDbInfo[]>('redis_db_info', { id: connectionId })
        if (!cancelled) setDbList(connectionId, list)
      } catch (_) {}
    }
    init()
    return () => { cancelled = true }
  }, [connectionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 监听大集合删除进度事件 ───────────────────────────────────────────────
  useEffect(() => {
    const unlisten = listen<{ id?: string; key: string; deleted: number }>('redis_del_progress', (ev) => {
      // 仅响应本连接的进度，避免双开 Redis 标签时进度互串
      if (ev.payload.id && ev.payload.id !== connectionId) return
      setDelProgress(ev.payload.deleted)
    })
    return () => { unlisten.then(f => f()) }
  }, [connectionId])

  // ── SCAN 加载 key ────────────────────────────────────────────────────────
  const scan = useCallback(async (pat: string, cur: number, append: boolean) => {
    const gen = ++genRef.current
    setLoading(true)
    setError('')
    try {
      const res = await invoke<RedisScanResult>('redis_scan', {
        id: connectionId, pattern: pat, cursor: cur, db: activeDb,
      })
      if (gen !== genRef.current) return
      setAllKeys(prev => append ? [...prev, ...res.keys] : res.keys)
      setCursor(res.cursor)
      setHasMore(res.hasMore)
    } catch (e) {
      if (gen === genRef.current) setError(String(e))
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [connectionId, activeDb])

  useEffect(() => {
    genRef.current++
    setAllKeys([])
    setCursor(0)
    setSelected(null)
    scan('', 0, false)
  }, [connectionId, activeDb, scan])

  // ── DB 切换 ──────────────────────────────────────────────────────────────
  const switchDb = useCallback((db: number) => {
    setActiveDb(connectionId, db)
    setShowDbPicker(false)
    setAllKeys([])
    setSelected(null)
  }, [connectionId, setActiveDb])

  // ── 删除 key ─────────────────────────────────────────────────────────────
  const doDelete = async (key: string, large: boolean) => {
    setDeleting(true)
    setDelProgress(null)
    try {
      if (large) {
        await invoke('redis_delete_large', {
          id: connectionId, key, db: activeDb,
          caps: caps?.caps ?? null,
        })
      } else {
        await invoke('redis_del', {
          id: connectionId, key, db: activeDb,
          caps: caps?.caps ?? null,
        })
      }
      setAllKeys(prev => prev.filter(k => k.key !== key))
      if (selected === key) setSelected(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setDeleting(false)
      setDelProgress(null)
      setConfirmDel(null)
    }
  }

  // ── 刷新 DB 列表 ────────────────────────────────────────────────────────
  const refreshDbList = async () => {
    try {
      const list = await invoke<RedisDbInfo[]>('redis_db_info', { id: connectionId })
      setDbList(connectionId, list)
    } catch (_) {}
  }

  // ── 构建前缀树（分隔符来自连接配置 extraJson.keySeparator，默认 ':'）──────────
  const separator = (() => {
    try {
      const ex = redisConn?.extraJson ? JSON.parse(redisConn.extraJson) : null
      const s = ex?.keySeparator
      return (typeof s === 'string' && s.length > 0) ? s : ':'
    } catch { return ':' }
  })()
  const treeRoot = buildPrefixTree(allKeys, separator)

  const toggleNode = (prefix: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  // ── 渲染前缀树节点（递归）─────────────────────────────────────────────────
  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (!node.label) {
      // 无前缀 key 直接渲染叶子行
      return node.keys.map(k => renderKeyRow(k))
    }
    const isExpanded = expandedNodes.has(node.prefix)
    return (
      <div key={node.prefix} className="redis-tree-group">
        <div
          className="redis-tree-folder"
          style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => toggleNode(node.prefix)}
        >
          {isExpanded
            ? <ChevronDown size={11} className="redis-tree-arrow" />
            : <ChevronRight size={11} className="redis-tree-arrow" />
          }
          <Layers size={11} className="redis-tree-icon" />
          <span className="redis-tree-label">{node.label}</span>
          <span className="redis-tree-count">{node.keyCount}</span>
        </div>
        {isExpanded && (<>
          {node.keys.map(k => renderKeyRow(k, depth + 1))}
          {[...node.children.values()].map(child => renderNode(child, depth + 1))}
        </>)}
      </div>
    )
  }

  const renderKeyRow = (k: RedisKeyInfo, depth = 0) => (
    <div
      key={k.key}
      className={`redis-key-row${selected === k.key ? ' active' : ''}`}
      style={{ paddingLeft: 12 + depth * 12 }}
      onClick={() => setSelected(k.key)}
      onContextMenu={(e) => { e.preventDefault(); setSelected(k.key); setKeyCtxMenu({ x: e.clientX, y: e.clientY, key: k.key, kind: k.kind }) }}
    >
      <span className="redis-key-kind" style={{ color: KIND_COLOR[k.kind] ?? 'var(--text-muted)' }}>
        {k.kind.substring(0, 3)}
      </span>
      <span className="redis-key-name" title={k.key}>{k.key.split(separator).pop()}</span>
      <span className="redis-key-ttl">{fmtTtl(k.ttl)}</span>
      <button
        className="cmd-act-btn danger redis-key-del"
        onClick={(e) => {
          e.stopPropagation()
          // 超大 value 用渐进式删除（hash/set/zset/list，先估算大小）
          const large = ['hash', 'set', 'zset', 'list'].includes(k.kind)
          setConfirmDel({ key: k.key, large })
        }}
        title="删除"
      >
        ×
      </button>
    </div>
  )

  // ── 当前 DB 信息 ────────────────────────────────────────────────────────
  const currentDbInfo = dbList.find(d => d.db === activeDb)
  const totalDbKeys = currentDbInfo?.keys ?? 0

  return (
    <div className="redis-browser" style={{ flexDirection: 'column', position: 'relative' }}>
      <EnvWatermark envLabel={redisConn?.envLabel} readonly={redisConn?.readonly ?? redisConn?.readOnly} />
      {/* ── 顶部功能标签栏 ── */}
      <div className="redis-main-tabs" style={{ display: 'flex', alignItems: 'center' }}>
        {([['browser', '浏览器'], ['cli', 'CLI'], ['monitor', '监控'], ['pubsub', 'Pub/Sub'], ['tools', '工具'], ['dba', 'DBA']] as const).map(([k, label]) => (
          <button
            key={k}
            className={`redis-main-tab${mainTab === k ? ' active' : ''}`}
            onClick={() => setMainTab(k)}
          >{label}</button>
        ))}
        {isProduction && (
          <span style={{ marginLeft: 'auto', marginRight: 8, fontSize: 11, color: 'var(--error)', fontWeight: 700, border: '1px solid var(--error)', borderRadius: 4, padding: '1px 6px' }}>生产</span>
        )}
        {isReadonly && (
          <span style={{ marginLeft: isProduction ? 4 : 'auto', marginRight: 8, fontSize: 11, color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 4, padding: '1px 6px' }}>只读</span>
        )}
      </div>

      {/* ── CLI 面板 ── */}
      {mainTab === 'cli' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <CliPanel connectionId={connectionId} db={activeDb} />
        </div>
      )}

      {/* ── 监控面板 ── */}
      {mainTab === 'monitor' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <InfoDashboard connectionId={connectionId} db={activeDb} />
        </div>
      )}

      {/* ── Pub/Sub 面板 ── */}
      {mainTab === 'pubsub' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <PubSubPanel connectionId={connectionId} db={activeDb} />
        </div>
      )}

      {/* ── 工具面板 ── */}
      {mainTab === 'tools' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ToolsPanel
            connectionId={connectionId}
            db={activeDb}
            isReadonly={isReadonly}
            isProduction={isProduction}
            caps={caps?.caps ?? 0}
            onReadonlyChange={async (v) => {
              try { await invoke('redis_set_readonly', { id: connectionId, readonly: v }) } catch (_) {}
              setIsReadonly(v)
            }}
            onProductionChange={setIsProduction}
          />
        </div>
      )}

      {/* ── DBA 管理面板 ── */}
      {mainTab === 'dba' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <DbaPanel connectionId={connectionId} db={activeDb} caps={caps?.caps ?? 0} />
        </div>
      )}

      {/* ── 浏览器视图 ── */}
      {mainTab === 'browser' && <div className="redis-browser__body">
      {/* ── 左栏：DB 选择器 + key 列表 ── */}
      <div className="redis-keys">
        {/* 头部工具栏 */}
        <div className="redis-keys__header">
          {/* DB 选择器 */}
          <div className="redis-db-picker" style={{ position: 'relative' }}>
            <button
              className="redis-db-btn"
              onClick={() => { refreshDbList(); setShowDbPicker(p => !p) }}
              title="切换数据库"
            >
              <Database size={11} strokeWidth={2} />
              <span>db{activeDb}</span>
              {totalDbKeys > 0 && <span className="redis-db-count">{totalDbKeys.toLocaleString()}</span>}
              <ChevronDown size={10} />
            </button>
            {showDbPicker && createPortal(
              <div className="redis-dblist-overlay" onMouseDown={() => setShowDbPicker(false)}>
                <div
                  className="redis-dblist"
                  onMouseDown={e => e.stopPropagation()}
                  style={{ position: 'fixed', top: 40, left: 12, zIndex: 9999 }}
                >
                  {(dbList.length > 0 ? dbList : Array.from({ length: 16 }, (_, i) => ({ db: i, keys: 0, expires: 0 }))).map(d => (
                    <button
                      key={d.db}
                      className={`redis-dblist-item${d.db === activeDb ? ' active' : ''}`}
                      onClick={() => switchDb(d.db)}
                    >
                      <span>db{d.db}</span>
                      {d.keys > 0 && <span className="redis-dblist-keys">{d.keys.toLocaleString()}</span>}
                    </button>
                  ))}
                </div>
              </div>,
              document.body
            )}
          </div>

          {caps && (
            <span className="redis-version-badge" title={`${caps.mode} · ${caps.os}`}>
              {caps.version}
            </span>
          )}

          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button
              className="ssh-panel__btn"
              onClick={() => setShowNewKey(true)}
              title="新建 Key"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
            <button
              className="ssh-panel__btn"
              onClick={() => scan(pattern, 0, false)}
              title="刷新"
            >
              <RefreshCw size={12} strokeWidth={2} className={loading ? 'spin' : ''} />
            </button>
          </span>
        </div>

        {/* 搜索框 */}
        <div className="redis-search">
          <Search size={12} className="redis-search__icon" />
          <input
            ref={searchInputRef}
            className="redis-search__input"
            placeholder="匹配模式，如 user:*"
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') scan(pattern, 0, false) }}
          />
        </div>

        {error && <div className="redis-error">{error}</div>}

        {/* Key 列表（前缀树） */}
        <div className="redis-keys__list">
          {[...treeRoot.values()].map(node => renderNode(node, 0))}
          {!loading && allKeys.length === 0 && !error && (
            <div className="panel-empty">没有匹配的 key</div>
          )}
          {loading && (
            <div className="panel-empty"><Loader2 size={14} className="spin" /></div>
          )}
          {hasMore && !loading && (
            <button className="redis-more-btn" onClick={() => scan(pattern, cursor, true)}>
              加载更多
            </button>
          )}
        </div>

        {/* 状态栏 */}
        <div className="redis-keys__footer">
          <span>{allKeys.length} 个 key{hasMore ? '（部分）' : ''}</span>
        </div>
      </div>

      {/* ── 右栏：值编辑器 ── */}
      <div className="redis-value">
        {selected ? (
          <ValueEditor
            connectionId={connectionId}
            keyName={selected}
            db={activeDb}
            caps={caps?.caps ?? 0}
            onDeleted={() => {
              setAllKeys(prev => prev.filter(k => k.key !== selected))
              setSelected(null)
            }}
            onRenamed={(newKey) => {
              setAllKeys(prev => prev.map(k => k.key === selected ? { ...k, key: newKey } : k))
              setSelected(newKey)
            }}
            externalTrigger={keyTrigger}
            onTriggerHandled={() => setKeyTrigger(null)}
          />
        ) : (
          <div className="result-placeholder"><span>选择左侧 key 查看值</span></div>
        )}
      </div>

      {/* ── 删除确认弹窗 ── */}
      <ConfirmDialog
        open={confirmDel !== null}
        title="删除 Key"
        desc={
          confirmDel?.large
            ? `确认删除 "${confirmDel?.key}"？该 key 属于集合类型，将使用渐进式删除避免阻塞 Redis，操作无法撤销。`
            : `确认删除 "${confirmDel?.key}"？该操作无法撤销。`
        }
        danger
        okText={deleting ? (delProgress !== null ? `删除中 (${delProgress})…` : '删除中…') : '删除'}
        onOk={() => confirmDel && doDelete(confirmDel.key, !!confirmDel.large)}
        onCancel={() => !deleting && setConfirmDel(null)}
      />

      {/* ── 新建 Key 弹窗 ── */}
      {showNewKey && (
        <NewKeyDialog
          connectionId={connectionId}
          db={activeDb}
          onCreated={() => { setShowNewKey(false); scan(pattern, 0, false) }}
          onClose={() => setShowNewKey(false)}
        />
      )}

      {/* KB4.4 Key 列表右键菜单 */}
      {keyCtxMenu && (
        <ContextMenu
          x={keyCtxMenu.x}
          y={keyCtxMenu.y}
          onClose={() => setKeyCtxMenu(null)}
          items={[
            {
              label: '复制 key 名',
              icon: <Copy size={12} />,
              shortcut: sc('redisCopyKey'),
              onClick: () => navigator.clipboard.writeText(keyCtxMenu.key).catch(() => {}),
            },
            { label: undefined },
            {
              label: '重命名…',
              icon: <Pencil size={12} />,
              shortcut: sc('redisRename'),
              disabled: isReadonly,
              onClick: () => setKeyTrigger('rename'),
            },
            {
              label: '编辑 TTL…',
              icon: <Clock3 size={12} />,
              shortcut: sc('redisTtlEdit'),
              disabled: isReadonly,
              onClick: () => setKeyTrigger('ttl'),
            },
            { label: undefined },
            {
              label: '删除 key',
              icon: <Trash2 size={12} />,
              shortcut: sc('redisDeleteKey'),
              danger: true,
              disabled: isReadonly,
              onClick: () => {
                const large = ['hash', 'set', 'zset', 'list'].includes(keyCtxMenu.kind)
                setConfirmDel({ key: keyCtxMenu.key, large })
              },
            },
          ]}
        />
      )}
      </div>}
    </div>
  )
}
