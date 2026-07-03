// OR4.7 — Oracle 误删恢复 / RMAN / Data Pump 引导（只读说明，不执行实际恢复）
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, BookOpen, Copy, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  onClose: () => void
  embedded?: boolean
}

interface Section {
  id: string
  title: string
  risk: 'info' | 'warn' | 'danger'
  // render 函数而非 ReactNode，避免 SECTIONS 在函数体内构造时 Code type 不稳定
  content: (copied: string, onCopy: (s: string) => void) => React.ReactNode
}

// 顶层定义，type 引用稳定，React reconcile 不会 remount
interface CodeProps { children: string; copied: string; onCopy: (s: string) => void }
const Code = ({ children, copied, onCopy }: CodeProps) => (
  <div style={{ position: 'relative', marginTop: 8 }}>
    <pre style={{ margin: 0, padding: '10px 36px 10px 12px', background: 'var(--surface-2)', borderRadius: 7, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border)' }}>{children}</pre>
    <button onClick={() => onCopy(children)} style={{ position: 'absolute', top: 6, right: 6, color: copied === children ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4 }}>
      {copied === children ? <CheckCircle size={12} /> : <Copy size={12} />}
    </button>
  </div>
)

// SECTIONS 在模块顶层定义，不依赖 copied/copy 闭包
const SECTIONS: Section[] = [
  {
    id: 'flashback',
    title: '场景1：Flashback 查询 — 读取过去某时刻的数据',
    risk: 'info',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 8px' }}>Flashback Query 基于 UNDO 数据，无需备份，适合误 DELETE/UPDATE 场景（需 UNDO 保留窗口内）。</p>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 按时间点查看历史数据：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 查看 30 分钟前的数据快照
SELECT * FROM schema.table_name
AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '30' MINUTE);

-- 查看指定时间点
SELECT * FROM schema.table_name
AS OF TIMESTAMP TO_TIMESTAMP('2024-01-15 14:30:00', 'YYYY-MM-DD HH24:MI:SS');`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 用 SCN 定位（更精确）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 查询当前 SCN（记录误操作前的 SCN）
SELECT CURRENT_SCN FROM V$DATABASE;

-- 按 SCN 查询历史状态
SELECT * FROM schema.table_name AS OF SCN 1234567890;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 确认后将历史数据插回：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 将误删数据从历史快照插回当前表
INSERT INTO schema.table_name
SELECT * FROM schema.table_name
AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '30' MINUTE)
WHERE id IN (101, 102, 103);  -- 替换为实际被删 ID
COMMIT;`}</Code>
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(234,88,12,0.1)', borderRadius: 7, border: '1px solid rgba(234,88,12,0.3)', fontSize: 11.5, color: '#ea580c' }}>
          ⚠ Flashback Query 依赖 UNDO 保留时间（UNDO_RETENTION 参数）。如超出保留窗口，会报 ORA-01555（快照过旧），只能从备份恢复。
        </div>
      </div>
    ),
  },
  {
    id: 'flashback_table',
    title: '场景2：Flashback Table — 将整张表回滚到历史状态（高危）',
    risk: 'danger',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 8px' }}>Flashback Table 将表的所有行回滚到指定时间点，适合整表误操作。需要启用行移动（ROW MOVEMENT）。</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 步骤1：启用行移动（允许 Flashback 修改 ROWID）
ALTER TABLE schema.table_name ENABLE ROW MOVEMENT;

-- 步骤2：将表闪回到指定时间点（当前数据将被覆盖！）
FLASHBACK TABLE schema.table_name
TO TIMESTAMP TO_TIMESTAMP('2024-01-15 14:30:00', 'YYYY-MM-DD HH24:MI:SS');

-- 步骤3：确认后恢复行移动限制（可选）
ALTER TABLE schema.table_name DISABLE ROW MOVEMENT;`}</Code>
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(220,38,38,0.1)', borderRadius: 7, border: '1px solid rgba(220,38,38,0.3)', fontSize: 11.5, color: '#dc2626' }}>
          🚨 Flashback Table 会覆盖当前表数据，不可撤销。执行前务必先用 AS OF 查询确认目标时间点的数据正确，并在测试环境验证。
        </div>
      </div>
    ),
  },
  {
    id: 'recyclebin',
    title: '场景3：回收站 — 恢复误 DROP 的表',
    risk: 'warn',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 8px' }}>DROP TABLE 后表进入回收站（除非用 PURGE 永久删除），可通过 FLASHBACK TABLE 从回收站恢复。</p>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 查看回收站中的表：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 当前用户的回收站
SELECT OBJECT_NAME, ORIGINAL_NAME, DROPTIME FROM RECYCLEBIN
ORDER BY DROPTIME DESC;

-- DBA 视角（所有用户）
SELECT OWNER, OBJECT_NAME, ORIGINAL_NAME, DROPTIME FROM DBA_RECYCLEBIN
ORDER BY DROPTIME DESC;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 从回收站恢复：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 按原始表名恢复（可能有多个同名条目，取最新的）
FLASHBACK TABLE schema.table_name TO BEFORE DROP;

-- 恢复并重命名（避免与当前对象冲突）
FLASHBACK TABLE schema.table_name TO BEFORE DROP RENAME TO table_name_restored;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 永久清除（不可恢复）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 清除特定对象
PURGE TABLE schema.table_name;

-- 清除整个回收站
PURGE RECYCLEBIN;`}</Code>
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(234,88,12,0.1)', borderRadius: 7, border: '1px solid rgba(234,88,12,0.3)', fontSize: 11.5, color: '#ea580c' }}>
          ⚠ 如果 DROP TABLE 时使用了 PURGE 关键字，或表空间不足触发了回收站清理，则表已永久删除，无法从回收站恢复。
        </div>
      </div>
    ),
  },
  {
    id: 'rman',
    title: '场景4：RMAN 物理备份恢复（依赖服务器）',
    risk: 'danger',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 8px' }}>RMAN 恢复需要服务器访问权限，在数据库服务器上执行（不在 DBTerm 内），以下为操作参考。</p>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 连接 RMAN（在服务器终端）：</p>
        <Code copied={copied} onCopy={onCopy}>{`# 连接到目标数据库
rman target /
# 或指定连接字符串
rman target sys@orcl`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 数据库级 PITR（完整时间点恢复）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- RMAN 命令
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;

RESTORE DATABASE UNTIL TIME "TO_DATE('2024-01-15 14:30:00','YYYY-MM-DD HH24:MI:SS')";
RECOVER DATABASE UNTIL TIME "TO_DATE('2024-01-15 14:30:00','YYYY-MM-DD HH24:MI:SS')";

ALTER DATABASE OPEN RESETLOGS;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 表空间级恢复（减少停机时间）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 仅恢复指定表空间（需将其脱机）
ALTER TABLESPACE users OFFLINE;

RESTORE TABLESPACE users UNTIL TIME
  "TO_DATE('2024-01-15 14:30:00','YYYY-MM-DD HH24:MI:SS')";
RECOVER TABLESPACE users UNTIL TIME
  "TO_DATE('2024-01-15 14:30:00','YYYY-MM-DD HH24:MI:SS')";

ALTER TABLESPACE users ONLINE;`}</Code>
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(220,38,38,0.1)', borderRadius: 7, border: '1px solid rgba(220,38,38,0.3)', fontSize: 11.5, color: '#dc2626' }}>
          🚨 数据库级 PITR 会影响整个数据库，需使用 RESETLOGS 重置归档序列。执行前确保所有用户已退出，并已通知相关团队。
        </div>
      </div>
    ),
  },
  {
    id: 'datapump',
    title: '场景5：Data Pump — 逻辑备份导出/导入',
    risk: 'info',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 8px' }}>Data Pump (expdp/impdp) 是 Oracle 推荐的逻辑备份工具，在服务器上执行。</p>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 导出（在服务器终端）：</p>
        <Code copied={copied} onCopy={onCopy}>{`# 导出整个 schema
expdp scott/tiger@orcl DIRECTORY=DATA_PUMP_DIR DUMPFILE=scott_backup.dmp \\
  SCHEMAS=scott LOGFILE=scott_export.log

# 仅导出特定表
expdp scott/tiger@orcl DIRECTORY=DATA_PUMP_DIR DUMPFILE=tables_backup.dmp \\
  TABLES=scott.emp,scott.dept LOGFILE=tables_export.log`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 导入（恢复时）：</p>
        <Code copied={copied} onCopy={onCopy}>{`# 导入到原 schema（表已存在时可加 TABLE_EXISTS_ACTION=REPLACE）
impdp scott/tiger@orcl DIRECTORY=DATA_PUMP_DIR DUMPFILE=scott_backup.dmp \\
  SCHEMAS=scott TABLE_EXISTS_ACTION=REPLACE LOGFILE=scott_import.log

# 导入到不同 schema（跨实例迁移）
impdp system/syspass@target_orcl DIRECTORY=DATA_PUMP_DIR DUMPFILE=scott_backup.dmp \\
  REMAP_SCHEMA=scott:new_schema LOGFILE=import.log`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 在 Oracle 内创建导出目录对象：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- DBA 创建目录对象（指向服务器实际路径）
CREATE OR REPLACE DIRECTORY DATA_PUMP_DIR AS '/u01/backup/datapump';
GRANT READ, WRITE ON DIRECTORY DATA_PUMP_DIR TO scott;`}</Code>
      </div>
    ),
  },
  {
    id: 'prevention',
    title: '预防措施：生产数据库标准配置',
    risk: 'info',
    content: (copied, onCopy) => (
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 开启归档模式（ARCHIVELOG）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 检查当前模式
SELECT LOG_MODE FROM V$DATABASE;

-- 切换到归档模式（需 MOUNT 状态）
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 确保 UNDO 保留时间足够（默认 900s 太短）：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- 查看当前设置
SHOW PARAMETER UNDO_RETENTION;

-- 调整为 7200 秒（2小时）
ALTER SYSTEM SET UNDO_RETENTION = 7200 SCOPE=BOTH;`}</Code>
        <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 定期 RMAN 备份策略：</p>
        <Code copied={copied} onCopy={onCopy}>{`-- RMAN 配置（在服务器执行）
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;

-- 每日全备脚本（加入 crontab）
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;`}</Code>
      </div>
    ),
  },
]

export default function OraclePitrGuidePanel({ onClose, embedded }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['flashback']))
  const [copied, setCopied] = useState('')

  const copy = (s: string) => {
    navigator.clipboard.writeText(s)
    setCopied(s)
    setTimeout(() => setCopied(''), 1500)
  }

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const riskColor = (r: 'info' | 'warn' | 'danger') =>
    r === 'danger' ? '#dc2626' : r === 'warn' ? '#ea580c' : 'var(--accent)'

  const inner = (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: 7 }}>
        本指南仅包含 Oracle 数据恢复的操作思路与示例代码，<strong>不会直接修改任何数据</strong>。RMAN/Data Pump 操作须在服务器终端执行；Flashback 操作需在 SQLEditor 中执行并确认。
      </div>
      {SECTIONS.map(sec => (
        <div key={sec.id} style={{ marginBottom: 8, border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
          <button
            onClick={() => toggle(sec.id)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--surface-2)', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <AlertTriangle size={13} color={riskColor(sec.risk)} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text-bright)' }}>{sec.title}</span>
            {expanded.has(sec.id) ? <ChevronDown size={13} color="var(--text-muted)" /> : <ChevronRight size={13} color="var(--text-muted)" />}
          </button>
          {expanded.has(sec.id) && (
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              {sec.content(copied, copy)}
            </div>
          )}
        </div>
      ))}
    </div>
  )

  if (embedded) {
    return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>{inner}</div>
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 740, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BookOpen size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>Oracle 误删恢复指南</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>只读说明 · 不执行实际恢复</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
