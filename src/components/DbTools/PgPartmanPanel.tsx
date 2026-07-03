// PG6.3 — pg_partman 自动分区维护
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Layers, RefreshCw, AlertTriangle, Copy, CheckCircle } from 'lucide-react'

interface Props {
  connectionId: string
  schema?: string
  onClose: () => void
  onRunSql?: (sql: string) => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface PartmanConfig {
  parentTable: string
  controlColumn: string
  partitionType: string
  partitionInterval: string
  retention: string | null
  retentionKeepTable: boolean
  premake: number
  automaticMaintenance: string
  lastPartitionCreated: string
  lastRunTime: string
  totalPartitions: number
}

export default function PgPartmanPanel({ connectionId, schema, onClose, onRunSql, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasPartman, setHasPartman] = useState<boolean | null>(null)
  const [configs, setConfigs] = useState<PartmanConfig[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [running, setRunning] = useState(false)
  const [runMsg, setRunMsg] = useState('')

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const q = async (sql: string) => {
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    return invoke<R>('execute_query', { id: connectionId, sql })
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      // 检测 pg_partman 是否已安装
      const extRes = await q(`SELECT extname FROM pg_extension WHERE extname = 'pg_partman'`)
      const installed = extRes.rows.length > 0
      setHasPartman(installed)
      if (!installed) { setLoading(false); return }

      // 读取 partman.part_config
      const schemaFilter = schema ? `WHERE parent_table LIKE '${schema.replace(/'/g, "''")}%'` : ''
      const res = await q(`SELECT parent_table, control, partition_type, partition_interval,
          retention, retention_keep_table, premake, automatic_maintenance,
          '' AS last_part,
          COALESCE(maintenance_last_run::text, '') AS last_run
        FROM partman.part_config
        ${schemaFilter}
        ORDER BY parent_table`)

      const cfgList: PartmanConfig[] = []
      for (const r of res.rows) {
        const parentTable = String(r[0] ?? '')
        // 统计该表分区数
        let totalParts = 0
        try {
          const cntRes = await q(`SELECT count(*) FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent
            JOIN pg_namespace n ON n.oid = p.relnamespace
            WHERE n.nspname||'.'||p.relname = '${parentTable.replace(/'/g, "''")}'`)
          totalParts = Number(cntRes.rows[0]?.[0] ?? 0)
        } catch { /* 忽略 */ }
        cfgList.push({
          parentTable,
          controlColumn:         String(r[1] ?? ''),
          partitionType:         String(r[2] ?? ''),
          partitionInterval:     String(r[3] ?? ''),
          retention:             r[4] ? String(r[4]) : null,
          retentionKeepTable:    r[5] === 'true' || r[5] === 't',
          premake:               Number(r[6] ?? 4),
          automaticMaintenance:  String(r[7] ?? 'on'),
          lastPartitionCreated:  String(r[8] ?? ''),
          lastRunTime:           String(r[9] ?? ''),
          totalPartitions:       totalParts,
        })
      }
      setConfigs(cfgList)
      if (cfgList.length > 0 && !selected) setSelected(cfgList[0].parentTable)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const cur = configs.find(c => c.parentTable === selected) ?? null

  const copyCmd = (cmd: string) => {
    navigator.clipboard.writeText(cmd)
    setCopied(cmd)
    setTimeout(() => setCopied(''), 1500)
  }

  const runMaintenance = async (table: string) => {
    if (!window.confirm(`确认手动触发 ${table} 的 pg_partman 维护（创建新分区 + 清理过期分区）？`)) return
    setRunning(true); setRunMsg(''); setError('')
    try {
      await q(`SELECT partman.run_maintenance('${table.replace(/'/g, "''")}'::text, TRUE)`)
      setRunMsg(`✓ ${table} 维护完成`)
      await load()
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  const fmtTime = (s: string) => (!s || s === 'null' || s === '') ? '—' : (() => { try { return new Date(s).toLocaleString() } catch { return s } })()

  const nativePartmanScript = (table: string, interval: string, colName: string) =>
    `-- 原生声明式分区滚动创建示例（无 pg_partman）
-- 表：${table}，列：${colName}，间隔：${interval}
-- 每次维护窗口运行以下脚本（可挂 cron）
DO $$
DECLARE
  next_start DATE := date_trunc('${interval === 'daily' || interval === '1 day' ? 'day' : 'month'}', NOW() + INTERVAL '1 ${interval === 'daily' || interval === '1 day' ? 'day' : 'month'}');
  next_end   DATE := next_start + INTERVAL '1 ${interval === 'daily' || interval === '1 day' ? 'day' : 'month'}';
  part_name  TEXT := '${table}_' || to_char(next_start, 'YYYYMM');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname||'.'||c.relname = part_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF ${table} FOR VALUES FROM (%L) TO (%L)',
      part_name, next_start, next_end
    );
    RAISE NOTICE '已创建分区：%', part_name;
  END IF;
END $$;`

  const inner = (
    <>
        {/* 嵌入模式：因无标题栏，单独提供一行内联紧凑刷新 */}
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>pg_partman 自动分区维护</span>
            <button onClick={load} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          </div>
        )}

        {runMsg && <div style={{ padding: '8px 16px', background: 'rgba(22,163,74,0.08)', color: 'var(--success)', fontSize: 12, flexShrink: 0 }}>{runMsg}</div>}
        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : hasPartman === false ? (
          <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
            <div style={{ display: 'flex', gap: 8, padding: '12px 14px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
              <AlertTriangle size={14} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: 'var(--warning)', lineHeight: 1.7 }}>
                <b>pg_partman 扩展未安装。</b><br />
                安装：<code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 5px' }}>apt install postgresql-14-partman</code>，然后在数据库内：<br />
                <code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 5px' }}>CREATE SCHEMA partman; CREATE EXTENSION pg_partman SCHEMA partman;</code>
              </div>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>无 pg_partman 的原生分区滚动维护脚本</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              如果不安装 pg_partman，可以用以下方式手动管理滚动分区：
            </div>
            {(() => {
              const script = nativePartmanScript('your_schema.your_table', 'monthly', 'created_at')
              return (
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>原生滚动分区示例（修改后保存为 cron 任务）</span>
                    <button onClick={() => { copyCmd(script); onRunSql?.(script) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: copied === script ? '#16a34a' : 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                      {copied === script ? <CheckCircle size={11} /> : <Copy size={11} />}
                      发送到编辑器
                    </button>
                  </div>
                  <pre style={{ margin: 0, padding: '10px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflow: 'auto' }}>{script}</pre>
                </div>
              )
            })()}
          </div>
        ) : configs.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
            <Layers size={32} color="var(--border)" />
            <div>pg_partman 已安装，但 partman.part_config 中无配置项</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>需先用 partman.create_parent() 初始化分区表</div>
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
            {/* 左侧表列表 */}
            <div style={{ width: 220, borderRight: '1px solid var(--border)', overflow: 'auto', flexShrink: 0, padding: '8px 0' }}>
              {configs.map(c => (
                <div
                  key={c.parentTable}
                  onClick={() => { setSelected(c.parentTable); setRunMsg('') }}
                  style={{
                    padding: '8px 14px', cursor: 'pointer',
                    background: selected === c.parentTable ? 'var(--accent-bg)' : 'transparent',
                    borderLeft: selected === c.parentTable ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: selected === c.parentTable ? 'var(--accent)' : 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.parentTable}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {c.partitionType} · {c.partitionInterval} · {c.totalPartitions} 个分区
                  </div>
                  {c.automaticMaintenance !== 'on' && (
                    <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 2 }}>⚠ 自动维护已关闭</div>
                  )}
                </div>
              ))}
            </div>

            {/* 右侧详情 */}
            {cur && (
              <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* 基本配置 */}
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>{cur.parentTable}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content 1fr)', gap: '6px 20px', fontSize: 12 }}>
                    {[
                      ['分区列', cur.controlColumn],
                      ['分区类型', cur.partitionType],
                      ['分区间隔', cur.partitionInterval],
                      ['预创建数', String(cur.premake)],
                      ['自动维护', cur.automaticMaintenance],
                      ['分区总数', String(cur.totalPartitions)],
                      ['上次维护', fmtTime(cur.lastRunTime)],
                    ].map(([k, v]) => (
                      <><span key={`k-${k}`} style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{k}</span>
                      <span key={`v-${k}`} style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{v}</span></>
                    ))}
                  </div>
                  {cur.retention && (
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>保留策略：</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: cur.retentionKeepTable ? '#ea580c' : '#dc2626' }}>
                        {cur.retention}（{cur.retentionKeepTable ? '保留表结构' : '删除旧分区'}）
                      </span>
                    </div>
                  )}
                </div>

                {/* 告警 */}
                {cur.automaticMaintenance !== 'on' && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
                    <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--warning)' }}>此表的自动维护已关闭（automatic_maintenance=off），新分区不会被自动创建。</div>
                  </div>
                )}

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => runMaintenance(cur.parentTable)}
                    disabled={running}
                    style={{ padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', opacity: running ? 0.6 : 1 }}
                  >
                    {running ? '维护中…' : '手动触发维护'}
                  </button>
                  <button
                    onClick={() => {
                      const sql = `SELECT partman.run_maintenance_proc();`
                      copyCmd(sql)
                      onRunSql?.(sql)
                    }}
                    style={{ padding: '7px 14px', borderRadius: 7, fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5 }}
                  >
                    <Copy size={11} /> run_maintenance_proc()
                  </button>
                </div>

                {/* 维护命令说明 */}
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <b>自动维护建议：</b>在 pg_cron 或操作系统 cron 中定期执行：<br />
                  <code style={{ background: 'var(--surface)', borderRadius: 3, padding: '1px 6px', display: 'inline-block', marginTop: 4 }}>
                    SELECT partman.run_maintenance_proc();
                  </code><br />
                  <span style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                    pg_partman 会根据 premake 值提前创建分区，并按 retention 策略自动删除或解附旧分区。
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入子tab行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Layers size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>pg_partman 自动分区维护</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
