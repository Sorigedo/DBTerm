// R6 数据导入导出 + R7 安全（只读模式、生产标识）+ R7.3 审计日志
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Download, Upload, Copy, Trash2, Clock, ShieldAlert, Eye } from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'
import ConfigComparePanel from '../DbTools/ConfigComparePanel'
import type { ConnType } from '../../types'
import { queueBackgroundExport } from '../../utils/exportTasks'
import { useExportTaskStore } from '../../stores/exportTaskStore'

interface Props {
  connectionId: string
  db: number
  isReadonly: boolean
  isProduction: boolean
  onReadonlyChange: (v: boolean) => void
  onProductionChange: (v: boolean) => void
  caps: number
}

interface BatchPreview { count: number; samples: string[] }
interface CrossCopyResult { copied: number; skipped: number; errors: string[] }

// 本地 Redis 操作审计日志（R7.3）
function getAuditLog(connId: string): AuditEntry[] {
  try { return JSON.parse(localStorage.getItem(`redis-audit-${connId}`) ?? '[]') } catch { return [] }
}
function addAuditEntry(connId: string, entry: Omit<AuditEntry, 'id'>) {
  const log = getAuditLog(connId)
  const newEntry: AuditEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}` }
  const updated = [newEntry, ...log].slice(0, 500)
  localStorage.setItem(`redis-audit-${connId}`, JSON.stringify(updated))
}
export function recordRedisAudit(connId: string, op: string, detail: string) {
  addAuditEntry(connId, { op, detail, ts: Math.floor(Date.now() / 1000) })
}

interface AuditEntry { id: string; op: string; detail: string; ts: number }

type ToolTab = '批量操作' | '导出' | '导入' | '跨实例复制' | '配置对比' | '审计日志'
const TOOL_TABS: ToolTab[] = ['批量操作', '导出', '导入', '跨实例复制', '配置对比', '审计日志']

export default function ToolsPanel({
  connectionId, db, isReadonly, isProduction, onReadonlyChange, onProductionChange, caps,
}: Props) {
  const [tab, setTab] = useState<ToolTab>('批量操作')
  const [error, setError] = useState('')
  const [showCompare, setShowCompare] = useState(false)

  // 批量操作
  const [batchPat,   setBatchPat]   = useState('')
  const [batchTtl,   setBatchTtl]   = useState('')
  const [preview,    setPreview]    = useState<BatchPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [confirmBatchDel, setConfirmBatchDel] = useState(false)
  const [confirmBatchTtl, setConfirmBatchTtl] = useState(false)
  const [batchResult, setBatchResult] = useState('')

  // 导出
  const [exportPat,  setExportPat]  = useState('*')
  const [exporting,  setExporting]  = useState(false)
  const [exportCount,setExportCount]= useState<number | null>(null)

  // 导入
  const [importing,  setImporting]  = useState(false)
  const [importOverwrite, setImportOverwrite] = useState(false)
  const [importResult, setImportResult] = useState('')

  // 跨实例复制
  const [dstConnId,  setDstConnId]  = useState('')
  const [copySrcPat, setCopySrcPat] = useState('*')
  const [copyKeys,   setCopyKeys]   = useState<string[]>([])
  const [copyOverwrite, setCopyOverwrite] = useState(false)
  const [confirmCopy, setConfirmCopy] = useState(false)
  const [copyResult, setCopyResult] = useState<CrossCopyResult | null>(null)

  // 审计日志
  const [auditLog, setAuditLog] = useState<AuditEntry[]>(() => getAuditLog(connectionId))
  const refreshAudit = () => setAuditLog(getAuditLog(connectionId))

  const doPreview = async () => {
    if (!batchPat.trim()) { setError('请输入匹配模式'); return }
    setPreviewLoading(true)
    setError('')
    try {
      const p = await invoke<BatchPreview>('redis_batch_preview', { id: connectionId, pattern: batchPat, db })
      setPreview(p)
    } catch (e) { setError(String(e)) }
    finally { setPreviewLoading(false) }
  }

  const doBatchDel = async () => {
    try {
      const n = await invoke<number>('redis_batch_del', { id: connectionId, pattern: batchPat, db, caps })
      setBatchResult(`已删除 ${n} 个 key`)
      setPreview(null)
      recordRedisAudit(connectionId, 'BATCH_DEL', `pattern=${batchPat} deleted=${n}`)
      refreshAudit()
    } catch (e) { setError(String(e)) }
    setConfirmBatchDel(false)
  }

  const doBatchTtl = async () => {
    const ttl = parseInt(batchTtl, 10)
    if (isNaN(ttl)) { setError('TTL 必须是整数秒'); return }
    try {
      const n = await invoke<number>('redis_batch_expire', { id: connectionId, pattern: batchPat, ttlSecs: ttl, db })
      setBatchResult(`已设置 ${n} 个 key 的 TTL`)
      recordRedisAudit(connectionId, 'BATCH_TTL', `pattern=${batchPat} ttl=${ttl} updated=${n}`)
      refreshAudit()
    } catch (e) { setError(String(e)) }
    setConfirmBatchTtl(false)
  }

  const doExport = async () => {
    const path = await save({ filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!path) return
    setExporting(true)
    setExportCount(null)
    setError('')
    queueBackgroundExport({
      connectionId,
      label: `Redis DB${db} · Key 导出`,
      filePath: path,
      prepare: taskId => listen<{ count: number }>(`redis_export_progress_${taskId}`, ev => {
        const count = ev.payload.count
        setExportCount(count)
        useExportTaskStore.getState().updateTask(taskId, {
          progressRows: count,
          message: `已导出 ${count.toLocaleString()} 个 Key`,
        })
      }),
      run: taskId => invoke<number>('redis_export_keys', {
        id: connectionId, pattern: exportPat, db, path, taskId,
      }),
      complete: count => {
        setExportCount(count)
        recordRedisAudit(connectionId, 'EXPORT', `pattern=${exportPat} path=${path} count=${count}`)
        refreshAudit()
        return { progressRows: count, message: `导出完成 · ${count.toLocaleString()} 个 Key` }
      },
      successMessage: count => `Redis 导出完成：${count.toLocaleString()} 个 Key`,
      errorPrefix: 'Redis 导出失败',
    })
    setExporting(false)
  }

  const doImport = async () => {
    const path = await open({ filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!path || typeof path !== 'string') return
    setImporting(true)
    setError('')
    try {
      const r = await invoke<{ imported: number; skipped: number; errors: string[] }>(
        'redis_import_keys', { id: connectionId, db, path, overwrite: importOverwrite }
      )
      setImportResult(`导入 ${r.imported}，跳过 ${r.skipped}${r.errors.length ? `，${r.errors.length} 个错误` : ''}`)
      recordRedisAudit(connectionId, 'IMPORT', `path=${path} imported=${r.imported} overwrite=${importOverwrite}`)
      refreshAudit()
    } catch (e) { setError(String(e)) }
    finally { setImporting(false) }
  }

  const previewCopyKeys = async () => {
    const p = await invoke<BatchPreview>('redis_batch_preview', { id: connectionId, pattern: copySrcPat, db })
      .catch(e => { setError(String(e)); return null })
    if (!p) return
    // 拿全量 keys
    const keys = await invoke<string[]>('redis_scan_pattern', { id: connectionId, pattern: copySrcPat, db, limit: 1000 })
      .catch(() => [])
    setCopyKeys(keys)
    setPreview(p)
  }

  const doCrossCopy = async () => {
    if (!dstConnId.trim()) { setError('请输入目标连接 ID'); return }
    try {
      const r = await invoke<CrossCopyResult>('redis_cross_copy', {
        srcId: connectionId, dstId: dstConnId, keys: copyKeys,
        srcDb: db, dstDb: db, overwrite: copyOverwrite,
      })
      setCopyResult(r)
      recordRedisAudit(connectionId, 'CROSS_COPY', `dst=${dstConnId} copied=${r.copied} skipped=${r.skipped}`)
      refreshAudit()
    } catch (e) { setError(String(e)) }
    setConfirmCopy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 只读/生产标识控制条 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px',
        background: isProduction ? 'rgba(220,38,38,0.08)' : isReadonly ? 'rgba(234,88,12,0.08)' : 'var(--surface)',
        borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        {isProduction && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--error)', fontWeight: 700 }}>
            <ShieldAlert size={12} /> 生产环境
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={isReadonly} onChange={e => onReadonlyChange(e.target.checked)} />
          <Eye size={11} /> 只读模式
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={isProduction} onChange={e => onProductionChange(e.target.checked)} />
          生产标识
        </label>
      </div>

      {/* 工具标签栏 */}
      <div className="redis-type-toolbar" style={{ gap: 0, padding: 0, flexShrink: 0 }}>
        {TOOL_TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '7px 12px', border: 'none', background: 'transparent', fontSize: 11,
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === t ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer',
          }}>{t}</button>
        ))}
      </div>

      {error && <div className="redis-error" style={{ margin: '0 12px 6px' }}>{error}</div>}

      {/* 批量操作 */}
      {tab === '批量操作' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="redis-search__input"
              style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)' }}
              placeholder="匹配模式，如 user:session:*"
              value={batchPat}
              onChange={e => { setBatchPat(e.target.value); setPreview(null); setBatchResult('') }}
            />
            <button className="ssh-panel__btn ssh-panel__btn--text" onClick={doPreview} disabled={previewLoading} title="预览匹配数量">预览</button>
          </div>

          {preview && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
              <div style={{ marginBottom: 6 }}>匹配到 <strong>{preview.count.toLocaleString()}</strong> 个 key</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>样例：{preview.samples.join('，')}{preview.count > preview.samples.length ? '…' : ''}</div>
            </div>
          )}

          {batchResult && <div style={{ fontSize: 12, color: 'var(--success)' }}>{batchResult}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="cdlg-btn"
              style={{ flex: 1, background: 'var(--error)', borderColor: '#dc2626', color: '#fff' }}
              onClick={() => { if (!preview) { setError('请先点击预览'); return } setConfirmBatchDel(true) }}
              disabled={isReadonly}
              title={isReadonly ? '只读模式已开启' : '批量删除'}
            >
              <Trash2 size={12} /> 批量删除
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="redis-search__input"
              style={{ width: 120, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)' }}
              type="number"
              placeholder="TTL (秒)"
              value={batchTtl}
              onChange={e => setBatchTtl(e.target.value)}
            />
            <button
              className="cdlg-btn"
              style={{ background: 'var(--warning)', borderColor: '#ea580c', color: '#fff' }}
              onClick={() => { if (!preview) { setError('请先点击预览'); return } setConfirmBatchTtl(true) }}
              disabled={isReadonly}
            >
              <Clock size={12} /> 批量设置 TTL
            </button>
          </div>
        </div>
      )}

      {/* 导出 */}
      {tab === '导出' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>导出匹配 pattern 的 key 为 JSON 文件（包含 type/TTL/value）</div>
          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="匹配模式，如 * 或 user:*"
            value={exportPat}
            onChange={e => setExportPat(e.target.value)}
          />
          <button className="cdlg-btn" style={{ alignSelf: 'flex-start', background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
            onClick={doExport} disabled={exporting}>
            <Download size={12} /> {exporting ? `导出中 ${exportCount ?? 0} 个…` : '选择路径并导出'}
          </button>
          {exportCount !== null && !exporting && <div style={{ fontSize: 12, color: 'var(--success)' }}>已导出 {exportCount} 个 key</div>}
        </div>
      )}

      {/* 导入 */}
      {tab === '导入' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>从 JSON 文件导入 key（格式需与导出一致）</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={importOverwrite} onChange={e => setImportOverwrite(e.target.checked)} />
            覆盖已存在的 key（危险：会覆盖线上数据）
          </label>
          <button className="cdlg-btn" style={{ alignSelf: 'flex-start', background: importOverwrite ? '#ea580c' : 'var(--accent)', color: '#fff', borderColor: importOverwrite ? '#ea580c' : 'var(--accent)' }}
            onClick={doImport} disabled={importing || isReadonly}>
            <Upload size={12} /> {importing ? '导入中…' : '选择文件并导入'}
          </button>
          {importResult && <div style={{ fontSize: 12, color: 'var(--success)' }}>{importResult}</div>}
          {isReadonly && <div style={{ fontSize: 11, color: 'var(--warning)' }}>只读模式已开启，无法导入</div>}
        </div>
      )}

      {/* 跨实例复制 */}
      {tab === '跨实例复制' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>将当前实例的 key 复制到另一个 Redis 实例（DUMP/RESTORE）</div>
          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="目标连接 ID（在连接面板查看）"
            value={dstConnId}
            onChange={e => setDstConnId(e.target.value)}
          />
          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="源匹配模式，如 cache:*"
            value={copySrcPat}
            onChange={e => setCopySrcPat(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={copyOverwrite} onChange={e => setCopyOverwrite(e.target.checked)} />
            目标已存在时覆盖（危险）
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ssh-panel__btn ssh-panel__btn--text" onClick={previewCopyKeys}>预览 key 列表</button>
            <button className="cdlg-btn"
              style={{ background: copyOverwrite ? '#ea580c' : 'var(--accent)', color: '#fff', borderColor: copyOverwrite ? '#ea580c' : 'var(--accent)' }}
              onClick={() => { if (!copyKeys.length) { setError('请先点击预览'); return } setConfirmCopy(true) }}
              disabled={isReadonly}>
              <Copy size={12} /> 复制到目标
            </button>
          </div>
          {copyKeys.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>将复制 {copyKeys.length} 个 key</div>
          )}
          {copyResult && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
              <div>已复制 {copyResult.copied}，跳过 {copyResult.skipped}</div>
              {copyResult.errors.length > 0 && (
                <div style={{ color: 'var(--error)', marginTop: 4 }}>{copyResult.errors.slice(0, 3).join('；')}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 配置对比 */}
      {tab === '配置对比' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>对比当前实例与另一个 Redis 实例的 CONFIG 配置，排查"测试与生产行为不一致"。密码类配置自动脱敏。</div>
          <button className="cdlg-btn"
            style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', alignSelf: 'flex-start' }}
            onClick={() => setShowCompare(true)}>
            打开配置对比
          </button>
          {showCompare && (
            <ConfigComparePanel
              connectionId={connectionId}
              connType={'redis' as ConnType}
              onClose={() => setShowCompare(false)}
            />
          )}
        </div>
      )}

      {/* 审计日志 */}
      {tab === '审计日志' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table className="redis-hash-table">
            <thead><tr><th>操作</th><th>详情</th><th style={{ width: 140 }}>时间</th></tr></thead>
            <tbody>
              {auditLog.map(e => (
                <tr key={e.id}>
                  <td className="redis-hash-field" style={{ fontWeight: 600, width: 120 }}>{e.op}</td>
                  <td className="redis-hash-value"><span className="redis-hash-val-text">{e.detail}</span></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(e.ts * 1000).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {auditLog.length === 0 && <div className="panel-empty">暂无审计记录</div>}
        </div>
      )}

      {/* 弹窗 */}
      <ConfirmDialog open={confirmBatchDel} title="批量删除确认"
        desc={`确认删除模式 "${batchPat}" 匹配的 ${preview?.count ?? '?'} 个 key？此操作不可撤销。`}
        danger okText="确认删除"
        onOk={doBatchDel}
        onCancel={() => setConfirmBatchDel(false)} />

      <ConfirmDialog open={confirmBatchTtl} title="批量设置 TTL"
        desc={`确认对模式 "${batchPat}" 匹配的 ${preview?.count ?? '?'} 个 key 设置 TTL = ${batchTtl} 秒？`}
        okText="确认设置"
        onOk={doBatchTtl}
        onCancel={() => setConfirmBatchTtl(false)} />

      <ConfirmDialog open={confirmCopy} title="跨实例复制确认"
        desc={`确认将 ${copyKeys.length} 个 key 复制到连接 "${dstConnId}"？${copyOverwrite ? '⚠ 目标已存在的 key 将被覆盖！' : ''}`}
        danger={copyOverwrite} okText="确认复制"
        onOk={doCrossCopy}
        onCancel={() => setConfirmCopy(false)} />
    </div>
  )
}
