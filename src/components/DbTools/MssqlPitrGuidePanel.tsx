// MS5.6 — SQL Server 误删恢复指南（只读说明，引导用户执行正确的恢复流程）
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
  content: React.ReactNode
}

export default function MssqlPitrGuidePanel({ onClose, embedded }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['txrollback']))
  const [copied, setCopied] = useState('')

  const copy = (s: string) => {
    navigator.clipboard.writeText(s)
    setCopied(s)
    setTimeout(() => setCopied(''), 1500)
  }

  const Code = ({ children }: { children: string }) => (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <pre style={{ margin: 0, padding: '10px 36px 10px 12px', background: 'var(--surface-2)', borderRadius: 7, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border)' }}>{children}</pre>
      <button onClick={() => copy(children)} style={{ position: 'absolute', top: 6, right: 6, color: copied === children ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4 }}>
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
      id: 'txrollback',
      title: '场景1：事务尚未提交，直接回滚',
      risk: 'info',
      content: (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 8px' }}>若误操作在同一事务中尚未提交（COMMIT），直接执行回滚：</p>
          <Code>ROLLBACK TRANSACTION;</Code>
          <p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>⚠ 若已提交则无效，需使用下方场景。</p>
        </div>
      ),
    },
    {
      id: 'fndblog',
      title: '场景2：已提交 DELETE，从事务日志读取误删数据',
      risk: 'warn',
      content: (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 8px' }}>SQL Server 事务日志记录了所有已提交的 DELETE 操作，可用 fn_dblog 读取（需 sysadmin 或 db_owner 权限）。</p>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 查看最近的 DELETE 操作（替换 YourTable）：</p>
          <Code>{`-- 查看近期 DELETE 日志（日志空间充足时有效）
SELECT [Begin Time], [Transaction ID], [Transaction Name],
       [Lock Information], [Description]
FROM fn_dblog(NULL, NULL)
WHERE [Operation] = 'LOP_DELETE_ROWS'
  AND [Context] = 'LCX_HEAP'
ORDER BY [Begin Time] DESC;`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 获取具体被删记录（需解析 RowLog Contents）：</p>
          <p style={{ margin: '0 0 4px', color: 'var(--text-muted)' }}>推荐使用第三方工具 <strong>ApexSQL Log</strong> 或 <strong>Quest LiteSpeed</strong> 读取日志，比手动解析 RowLog 容易得多。</p>
          <Code>{`-- 也可通过 sys.fn_dblog 配合 sys.fn_PhysLocFormatter 解析
-- 但建议优先从备份恢复或使用专业日志分析工具`}</Code>
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(234,88,12,0.1)', borderRadius: 7, border: '1px solid rgba(234,88,12,0.3)', fontSize: 11.5, color: '#ea580c' }}>
            ⚠ fn_dblog 只能读取当前活跃日志文件；若日志已被截断（SIMPLE 恢复模式或已 BACKUP LOG），无法读取历史记录。
          </div>
        </div>
      ),
    },
    {
      id: 'truncate',
      title: '场景3：TRUNCATE 截断整表数据',
      risk: 'danger',
      content: (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 8px' }}>TRUNCATE 是最小化日志操作，fn_dblog 无法读取被截断的行数据。唯一可靠的恢复途径：</p>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 时间点还原（PITR）— 需 FULL 或 BULK_LOGGED 恢复模式：</p>
          <Code>{`-- 1. 停止应用写入（避免覆盖日志）
-- 2. 备份当前尾日志
BACKUP LOG [YourDatabase] TO DISK = 'D:\\backup\\tail_log.bak'
  WITH NORECOVERY, NO_TRUNCATE;

-- 3. 将数据库还原到 TRUNCATE 发生前的时间点（需有完整备份链）
RESTORE DATABASE [YourDatabase]
  FROM DISK = 'D:\\backup\\full.bak'
  WITH NORECOVERY;
RESTORE LOG [YourDatabase]
  FROM DISK = 'D:\\backup\\log1.bak'
  WITH NORECOVERY, STOPAT = '2024-01-15 14:29:00';  -- TRUNCATE 前一分钟
RESTORE DATABASE [YourDatabase] WITH RECOVERY;`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 从镜像/可读副本拉取数据（AlwaysOn AG 环境）：</p>
          <Code>{`-- 在可读副本上查询，拉取数据后 INSERT 回主库
-- 须在 TRUNCATE 前副本尚未同步该 DDL（异步副本有延迟窗口）
SELECT * FROM [YourDatabase].[dbo].[YourTable];`}</Code>
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(220,38,38,0.1)', borderRadius: 7, border: '1px solid rgba(220,38,38,0.3)', fontSize: 11.5, color: '#dc2626' }}>
            🚨 SIMPLE 恢复模式下日志频繁截断，PITR 不可用。生产库务必使用 FULL 恢复模式并定期备份日志。
          </div>
        </div>
      ),
    },
    {
      id: 'droptable',
      title: '场景4：DROP TABLE 误删整张表',
      risk: 'danger',
      content: (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 8px' }}>表被删除后结构和数据均丢失，可尝试以下途径：</p>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 检查快照（Database Snapshot）是否存在：</p>
          <Code>{`-- 列出当前快照
SELECT name, source_database_id, create_date
FROM sys.databases WHERE source_database_id IS NOT NULL;

-- 从快照还原数据
SELECT * INTO [dbo].[YourTable_recovered]
FROM [YourSnapshot].[dbo].[YourTable];`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 时间点还原（同 TRUNCATE 场景3）</p>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>③ 若启用了 CDC（变更数据捕获）：</p>
          <Code>{`-- 查看 CDC 捕获的变更
SELECT ct.*, sys.fn_cdc_get_column_ordinal('dbo_YourTable', 'YourColumn')
FROM cdc.dbo_YourTable_CT ct
WHERE ct.__$operation = 1  -- 1=DELETE, 2=INSERT, 3=BEFORE_UPDATE, 4=AFTER_UPDATE
ORDER BY ct.__$start_lsn;`}</Code>
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(220,38,38,0.1)', borderRadius: 7, border: '1px solid rgba(220,38,38,0.3)', fontSize: 11.5, color: '#dc2626' }}>
            🚨 DROP TABLE 是不可逆 DDL。无快照、无备份、无 CDC 时数据永久丢失。建议生产环境开启 DDL 审计和 CDC。
          </div>
        </div>
      ),
    },
    {
      id: 'prevention',
      title: '预防措施：生产库标准配置',
      risk: 'info',
      content: (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>① 恢复模式（必须）：</p>
          <Code>{`-- 查看恢复模式
SELECT name, recovery_model_desc FROM sys.databases WHERE name = DB_NAME();

-- 改为完整恢复模式（FULL）
ALTER DATABASE [YourDatabase] SET RECOVERY FULL;`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>② 定期备份日志：</p>
          <Code>{`-- 每 15 分钟备份一次事务日志（防数据丢失窗口缩小到 15min）
BACKUP LOG [YourDatabase]
  TO DISK = 'D:\\backup\\log_' + REPLACE(CONVERT(VARCHAR, GETDATE(), 120), ':', '') + '.bak'
  WITH COMPRESSION;`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>③ 启用 CDC 变更捕获（针对核心表）：</p>
          <Code>{`-- 启用库级 CDC
EXEC sys.sp_cdc_enable_db;

-- 启用表级 CDC（替换 YourTable）
EXEC sys.sp_cdc_enable_table
  @source_schema = 'dbo',
  @source_name   = 'YourTable',
  @role_name     = NULL;`}</Code>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>④ 创建数据库快照（定期）：</p>
          <Code>{`CREATE DATABASE [YourDB_Snap_20240115] ON
  (NAME = 'YourDB', FILENAME = 'D:\\snapshots\\YourDB_20240115.ss')
AS SNAPSHOT OF [YourDatabase];`}</Code>
        </div>
      ),
    },
  ]

  const riskColor = (r: 'info' | 'warn' | 'danger') =>
    r === 'danger' ? '#dc2626' : r === 'warn' ? '#ea580c' : 'var(--accent)'

  const inner = (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: 7 }}>
        本指南仅包含 SQL Server 数据恢复的操作思路与示例 SQL，<strong>不会直接修改任何数据</strong>。执行恢复操作前请务必在测试环境验证，并确保有最新备份。
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
              {sec.content}
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
        style={{ width: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BookOpen size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>SQL Server 误删恢复指南</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>只读说明 · 不执行实际恢复</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
