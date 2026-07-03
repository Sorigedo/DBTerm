// MariaDB 物理工具引导（ColumnStore cpimport + mariabackup）
//
// 设计：纯引导面板。两类操作都需在「服务器本机 shell」执行、且依赖服务器已装对应工具，
// 超出应用内 DB 连接范畴，因此本面板不调用任何 shell，只根据填写参数生成可复制的命令与步骤，
// 由用户自行在服务器执行。与其它 MariaDB 面板完全独立，互不影响。
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, HardDriveDownload, Copy, Check, AlertTriangle } from 'lucide-react'

interface Props {
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

function CmdBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }
  return (
    <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 12px' }}>
      <pre style={{ margin: 0, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{cmd}</pre>
      <button onClick={copy} title="复制" style={{ position: 'absolute', top: 6, right: 6, color: copied ? 'var(--success)' : 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 3, lineHeight: 0, cursor: 'pointer' }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

export default function MariaPhysicalToolsPanel({ onClose, embedded }: Props) {
  const [tab, setTab] = useState<'columnstore' | 'mariabackup'>('columnstore')

  // ColumnStore cpimport 参数
  const [csDb, setCsDb] = useState('mydb')
  const [csTable, setCsTable] = useState('mytable')
  const [csFile, setCsFile] = useState('/data/import.csv')
  const [csDelim, setCsDelim] = useState(',')
  const [csEnclose, setCsEnclose] = useState('"')

  // mariabackup 参数
  const [bkDir, setBkDir] = useState('/backup/full')
  const [bkUser, setBkUser] = useState('root')
  const [bkHost, setBkHost] = useState('127.0.0.1')
  const [bkPort, setBkPort] = useState('3306')

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const cpimportCmd = `cpimport -s '${csDelim}' -E '${csEnclose}' ${csDb} ${csTable} ${csFile}`
  const cpimportMode2 = `cpimport -m 2 -s '${csDelim}' ${csDb} ${csTable} ${csFile}`

  const bkBackup = `mariabackup --backup \\
  --target-dir=${bkDir} \\
  --host=${bkHost} --port=${bkPort} --user=${bkUser} --password=<PASSWORD>`
  const bkPrepare = `mariabackup --prepare --target-dir=${bkDir}`
  const bkRestore = `# 1) 停止 MariaDB 服务\n# 2) 清空/移走原 datadir\nmariabackup --copy-back --target-dir=${bkDir}\n# 3) chown -R mysql:mysql /var/lib/mysql && 启动服务`

  const inner = (
    <>
        <div style={{ display: 'flex', padding: '0 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {([['columnstore', 'ColumnStore 导入'], ['mariabackup', '物理备份 mariabackup']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              padding: '8px 14px', fontSize: 12, fontWeight: tab === k ? 600 : 400,
              color: tab === k ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab === k ? 'var(--accent)' : 'transparent'}`, marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
            <AlertTriangle size={14} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              以下命令需在 <b>MariaDB 服务器本机的 shell</b> 中执行，且服务器须已安装对应工具。本面板不会代为执行任何 shell 命令，仅生成命令供你复制后自行运行。
            </div>
          </div>

          {tab === 'columnstore' && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                ColumnStore 列存引擎的高速批量导入用 <code>cpimport</code>，绕过 SQL 层直接写列存，远快于 <code>LOAD DATA</code>。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>数据库</span>
                <input value={csDb} onChange={e => setCsDb(e.target.value)} style={inp} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>表</span>
                <input value={csTable} onChange={e => setCsTable(e.target.value)} style={inp} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>分隔符</span>
                <input value={csDelim} onChange={e => setCsDelim(e.target.value)} style={inp} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>包围符</span>
                <input value={csEnclose} onChange={e => setCsEnclose(e.target.value)} style={inp} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>CSV 文件路径</div>
              <input value={csFile} onChange={e => setCsFile(e.target.value)} style={{ ...inp, fontFamily: 'var(--font-mono)' }} />
              <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>① 基本导入（单机模式）</div>
              <CmdBlock cmd={cpimportCmd} />
              <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>② 分布式导入（PM 模式，多节点 ColumnStore）</div>
              <CmdBlock cmd={cpimportMode2} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                提示：导入前确保表已创建为 <code>ENGINE=ColumnStore</code>；大文件建议先 <code>split</code> 分片并行导入；
                导入失败可查看 <code>/var/log/mariadb/columnstore/</code> 下日志。
              </div>
            </>
          )}

          {tab === 'mariabackup' && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <code>mariabackup</code> 做物理热备（不锁库），适合大库；恢复需停服替换 datadir。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>备份目录</span>
                <input value={bkDir} onChange={e => setBkDir(e.target.value)} style={{ ...inp, fontFamily: 'var(--font-mono)' }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>用户</span>
                <input value={bkUser} onChange={e => setBkUser(e.target.value)} style={inp} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>主机</span>
                <input value={bkHost} onChange={e => setBkHost(e.target.value)} style={inp} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>端口</span>
                <input value={bkPort} onChange={e => setBkPort(e.target.value)} style={inp} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>① 全量备份</div>
              <CmdBlock cmd={bkBackup} />
              <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>② 准备（应用 redo，使备份一致）</div>
              <CmdBlock cmd={bkPrepare} />
              <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>③ 恢复（需停服）</div>
              <CmdBlock cmd={bkRestore} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                请把 <code>&lt;PASSWORD&gt;</code> 换成实际密码（或改用 <code>--password</code> 交互输入避免泄露到 history）；增量备份用 <code>--incremental-basedir</code>。
              </div>
            </>
          )}
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
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 680, maxHeight: '86vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <HardDriveDownload size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>MariaDB 物理工具引导</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={14} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}

const inp: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6, width: '100%', boxSizing: 'border-box',
}
