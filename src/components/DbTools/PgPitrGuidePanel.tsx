// PG6.5 — 误删恢复引导（PITR / pg_dirtyread / 延迟备库）
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, BookOpen, Copy, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface Section {
  id: string
  title: string
  risk: 'info' | 'warn' | 'danger'
  content: React.ReactNode
}

export default function PgPitrGuidePanel({ onClose, embedded }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['pitr']))
  const [copied, setCopied] = useState('')

  const copy = (s: string) => {
    navigator.clipboard.writeText(s)
    setCopied(s)
    setTimeout(() => setCopied(''), 1500)
  }

  const Code = ({ children }: { children: string }) => (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <pre style={{ margin: 0, padding: '10px 36px 10px 12px', background: 'var(--surface-2)', borderRadius: 7, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border)' }}>{children}</pre>
      <button
        onClick={() => copy(children)}
        style={{ position: 'absolute', top: 6, right: 6, color: copied === children ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4 }}
      >
        {copied === children ? <CheckCircle size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const SECTIONS: Section[] = [
    {
      id: 'pitr',
      title: '方案一：基于 WAL 的时间点恢复（PITR）',
      risk: 'info',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: 'var(--text)', lineHeight: 1.75 }}>
          <div style={{ padding: '8px 12px', background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 7 }}>
            <b>前提：</b>必须开启 WAL 归档（<code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>archive_mode = on</code>）且已有 pg_basebackup 物理备份。
          </div>
          <div><b>第一步：</b>确认误操作时间（可查日志或 pg_stat_activity 历史）</div>
          <div><b>第二步：</b>在备机上停库，从基础备份还原</div>
          <Code>{`# 停机
pg_ctl stop -D /var/lib/postgresql/data

# 从基础备份还原
rsync -av /backups/base/ /var/lib/postgresql/data/`}</Code>
          <div><b>第三步：</b>配置 recovery_target_time 恢复到误操作前一刻</div>
          <Code>{`# postgresql.conf 或 recovery.conf（PG12+ 直接写 postgresql.conf）
restore_command = 'cp /backups/wal/%f %p'
recovery_target_time = '2024-01-15 14:29:00'
recovery_target_action = 'pause'   # 暂停在目标点，确认数据后再 promote`}</Code>
          <div><b>第四步：</b>启动数据库，验证数据，然后 promote</div>
          <Code>{`pg_ctl start -D /var/lib/postgresql/data
# 连接确认数据正确后：
SELECT pg_wal_replay_resume();   -- 解除暂停
# 或：pg_ctl promote  # 提升为主库`}</Code>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>⚠ 此方案会回滚到目标时间点之后的所有事务，请确认影响范围。建议在独立副本上恢复，不要直接在主库操作。</div>
        </div>
      ),
    },
    {
      id: 'logical-slot',
      title: '方案二：逻辑复制 + 延迟备库',
      risk: 'warn',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: 'var(--text)', lineHeight: 1.75 }}>
          <div>若有配置延迟备库（<code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>recovery_min_apply_delay</code>），可在误操作传播到备库之前读取历史数据。</div>
          <Code>{`# 备库 postgresql.conf
standby_mode = on
recovery_min_apply_delay = '30min'  # 备库比主库延迟 30 分钟

# 在延迟备库上暂停回放，查询历史数据
SELECT pg_wal_replay_pause();
-- 查询需要的数据
SELECT * FROM orders WHERE ...;
-- 确认后恢复回放
SELECT pg_wal_replay_resume();`}</Code>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>此方案不修改任何数据，仅读取延迟备库上的历史快照，是零风险的数据找回方式。</div>
        </div>
      ),
    },
    {
      id: 'dirtyread',
      title: '方案三：pg_dirtyread（读取已删除行，实验性）',
      risk: 'danger',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: 'var(--text)', lineHeight: 1.75 }}>
          <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 7 }}>
            <b>⚠ 高风险：</b>pg_dirtyread 读取未被 VACUUM 回收的死元组，仅适用于数据刚刚删除且 autovacuum 尚未运行的场景。需先在测试环境验证，且不保证数据完整性。
          </div>
          <div><b>前提：</b>安装 pg_dirtyread 扩展（<a style={{ color: 'var(--accent)' }}>github.com/df7cb/pg_dirtyread</a>）</div>
          <Code>{`-- 停止对该表的所有写入（防止 VACUUM 提前回收）
-- 然后尝试读取死元组：
SELECT * FROM pg_dirtyread('deleted_table') AS t(
  id bigint,
  name text,
  created_at timestamptz
)
WHERE dead;  -- 只看已删除的行`}</Code>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>pg_dirtyread 只能读取同一事务 ID 生命周期内删除的数据，TRUNCATE 后完全无法恢复。</div>
        </div>
      ),
    },
    {
      id: 'prevention',
      title: '预防措施：避免再次发生',
      risk: 'info',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text)', lineHeight: 1.75 }}>
          {[
            ['开启 WAL 归档', 'archive_mode = on + archive_command 配置归档路径（pg_basebackup + WAL 才能做 PITR）'],
            ['配置延迟备库', 'recovery_min_apply_delay = 30min ~ 2h，给管理员"反应时间"窗口'],
            ['定期物理备份', 'pg_basebackup 每日全量，或 pgBackRest/Barman 增量备份'],
            ['危险操作前快照', '在 DELETE/TRUNCATE 大量数据前 SELECT INTO backup_table，留临时副本'],
            ['禁止无 WHERE 删除', '在只读/DBA 审计规则中拦截无条件 DELETE/UPDATE/TRUNCATE'],
            ['使用回收站模式', '对核心业务表加 deleted_at 软删除列，实际 DELETE 延迟 7 天后才执行'],
          ].map(([title, desc]) => (
            <div key={title as string} style={{ display: 'flex', gap: 10, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 7 }}>
              <CheckCircle size={13} color="var(--success)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{title as string}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{desc as string}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ]

  const RISK_COLOR = { info: 'var(--accent)', warn: '#ea580c', danger: '#dc2626' }
  const RISK_BG    = { info: 'rgba(59,130,246,0.06)', warn: 'rgba(234,88,12,0.06)', danger: 'rgba(220,38,38,0.06)' }

  const inner = (
    <>
        <div style={{ flex: 1, overflow: 'auto', padding: embedded ? 12 : 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
            <AlertTriangle size={14} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: 'var(--error)', lineHeight: 1.7 }}>
              <b>PostgreSQL 无内置"闪回"功能。</b>误删恢复依赖事先配置的备份机制，且恢复操作有一定风险。
              发现误操作后：<b>立即停止写入、不要 VACUUM、联系 DBA</b>，争取最大恢复窗口。
            </div>
          </div>

          {SECTIONS.map(s => (
            <div key={s.id} style={{ border: `1px solid ${s.risk === 'danger' ? 'rgba(220,38,38,0.25)' : s.risk === 'warn' ? 'rgba(234,88,12,0.25)' : 'var(--border)'}`, borderRadius: 9, overflow: 'hidden' }}>
              <div
                onClick={() => toggle(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', background: RISK_BG[s.risk], userSelect: 'none' }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: RISK_COLOR[s.risk], background: `${RISK_COLOR[s.risk]}18`, borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase' }}>
                  {s.risk === 'danger' ? '高风险' : s.risk === 'warn' ? '中等' : '推荐'}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', flex: 1 }}>{s.title}</span>
                {expanded.has(s.id) ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />}
              </div>
              {expanded.has(s.id) && (
                <div style={{ padding: '12px 16px', borderTop: `1px solid ${s.risk === 'danger' ? 'rgba(220,38,38,0.15)' : 'var(--border-subtle)'}` }}>
                  {s.content}
                </div>
              )}
            </div>
          ))}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳
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
        style={{ width: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BookOpen size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>PG 误删恢复指南</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>只读说明 · 不执行实际恢复</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
