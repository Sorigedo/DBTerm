// MO10.3: MongoDB Schema 分析面板（文档采样推断字段结构）
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Search, Download, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import SearchableSelect from '../DbTools/SearchableSelect';

interface FieldTypeDistrib {
  bsonType: string;
  count: number;
  pct: number;
}

interface FieldInfo {
  path: string;
  presencePct: number;
  types: FieldTypeDistrib[];
  hasTypeConflict: boolean;
  sampleValues: string[];
}

interface SchemaReport {
  coll: string;
  sampleCount: number;
  totalCount: number;
  fields: FieldInfo[];
}

const TYPE_COLOR: Record<string, string> = {
  string:   'var(--accent)',
  int:      '#a78bfa',
  double:   '#f59e0b',
  bool:     '#10b981',
  date:     '#06b6d4',
  objectId: '#8b5cf6',
  null:     'var(--text-muted)',
  array:    '#ec4899',
  object:   '#f97316',
  other:    'var(--text-muted)',
};

function TypeBadge({ type, pct }: { type: string; pct: number }) {
  const color = TYPE_COLOR[type] ?? 'var(--text-muted)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      background: `${color}22`, color, border: `1px solid ${color}44`,
      borderRadius: 4, padding: '1px 6px', fontSize: 11, marginRight: 3, marginBottom: 2,
    }}>
      {type} <span style={{ opacity: 0.75 }}>{pct.toFixed(0)}%</span>
    </span>
  );
}

function PresenceBar({ pct }: { pct: number }) {
  const color = pct >= 95 ? '#16a34a' : pct >= 60 ? '#f59e0b' : '#dc2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{
        width: 60, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 38 }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function exportMarkdown(report: SchemaReport): string {
  const lines: string[] = [
    `# MongoDB Schema 数据字典`,
    ``,
    `**集合：** \`${report.coll}\`  `,
    `**采样量：** ${report.sampleCount} / ${report.totalCount} 文档  `,
    `**字段数：** ${report.fields.length}  `,
    ``,
    `## 字段结构`,
    ``,
    `| 字段路径 | 出现率 | 类型 | 类型冲突 | 示例 |`,
    `| -------- | ------ | ---- | :------: | ---- |`,
  ];
  for (const f of report.fields) {
    const types = f.types.map(t => `${t.bsonType}(${t.pct.toFixed(0)}%)`).join(', ');
    const conflict = f.hasTypeConflict ? '⚠️' : '-';
    const samples = f.sampleValues.join(', ');
    lines.push(`| \`${f.path}\` | ${f.presencePct.toFixed(1)}% | ${types} | ${conflict} | ${samples} |`);
  }
  return lines.join('\n');
}

interface Props {
  connId: string;
  db: string;
  coll: string;
  onClose: () => void;
}

export default function MongoSchemaPanel({ connId, db, coll, onClose }: Props) {
  const [loading, setLoading]         = useState(false);
  const [report, setReport]           = useState<SchemaReport | null>(null);
  const [error, setError]             = useState('');
  const [sampleSize, setSampleSize]   = useState(200);
  const [filter, setFilter]           = useState('');
  const [conflictOnly, setConflictOnly] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  async function run() {
    setLoading(true);
    setError('');
    try {
      const r = await invoke<SchemaReport>('mongo_schema_analyze', {
        id: connId, db, coll, sampleSize,
      });
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggleRow(path: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function doExport() {
    if (!report) return;
    const md = exportMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `schema_${db}_${coll}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredFields = report?.fields.filter(f => {
    if (conflictOnly && !f.hasTypeConflict) return false;
    if (filter && !f.path.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  }) ?? [];

  const conflictCount = report?.fields.filter(f => f.hasTypeConflict).length ?? 0;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: 60,
    }}>
      <div style={{
        width: 860, maxHeight: 'calc(100vh - 100px)',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 15 }}>Schema 分析</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 13 }}>
              {db}.{coll}
            </span>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
          }}>
            <X size={18} />
          </button>
        </div>

        {/* 工具栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>采样量</label>
          <SearchableSelect
            value={String(sampleSize)}
            onChange={v => setSampleSize(Number(v))}
            mono={false}
            width={110}
            items={[50, 100, 200, 500, 1000].map(n => ({ value: String(n), label: `${n} 条` }))}
          />
          <button
            onClick={run}
            disabled={loading}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '5px 16px', cursor: 'pointer',
              opacity: loading ? 0.6 : 1, fontSize: 13,
            }}
          >
            {loading ? '分析中…' : '开始分析'}
          </button>
          {report && (
            <>
              <div style={{ flex: 1, position: 'relative' }}>
                <Search size={13} style={{
                  position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--text-muted)', pointerEvents: 'none',
                }} />
                <input
                  type="text"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="过滤字段路径…"
                  style={{
                    width: '100%', paddingLeft: 28, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: 6, fontSize: 13, color: 'var(--text)', outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={conflictOnly}
                  onChange={e => setConflictOnly(e.target.checked)}
                />
                仅看冲突
              </label>
              <button
                onClick={doExport}
                style={{
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '4px 12px', cursor: 'pointer',
                  fontSize: 13, color: 'var(--text)',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <Download size={13} /> 导出 MD
              </button>
            </>
          )}
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {error && (
            <div style={{
              background: '#dc262622', border: '1px solid #dc2626',
              borderRadius: 8, padding: '10px 14px', color: 'var(--error)', marginBottom: 14,
            }}>
              {error}
            </div>
          )}

          {!report && !loading && !error && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14 }}>
              选择采样量后点击「开始分析」，将对集合文档进行随机采样并推断字段结构
            </div>
          )}

          {loading && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60 }}>采样分析中，请稍候…</div>
          )}

          {report && (
            <>
              {/* 概要 */}
              <div style={{
                display: 'flex', gap: 16, marginBottom: 16,
                background: 'var(--surface-2)', borderRadius: 10, padding: '12px 16px',
              }}>
                <Stat label="采样文档" value={report.sampleCount.toLocaleString()} />
                <Stat label="集合总量" value={report.totalCount.toLocaleString()} />
                <Stat label="字段数" value={report.fields.length.toString()} />
                <Stat
                  label="类型冲突"
                  value={conflictCount.toString()}
                  warn={conflictCount > 0}
                />
              </div>

              {conflictCount > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: '#ea580c22', border: '1px solid #ea580c',
                  borderRadius: 8, padding: '8px 14px', marginBottom: 12,
                  fontSize: 13, color: 'var(--warning)',
                }}>
                  <AlertTriangle size={14} />
                  发现 {conflictCount} 个字段存在多类型冲突，可能是应用层数据类型不一致的信号
                </div>
              )}

              {/* 字段表 */}
              {filteredFields.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>无匹配字段</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 500 }}>字段路径</th>
                      <th style={{ padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 500, width: 130 }}>出现率</th>
                      <th style={{ padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 500 }}>类型分布</th>
                      <th style={{ padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 500 }}>示例值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFields.map(f => {
                      const expanded = expandedRows.has(f.path);
                      return (
                        <tr
                          key={f.path}
                          onClick={() => toggleRow(f.path)}
                          style={{
                            borderBottom: '1px solid var(--border-subtle)',
                            cursor: 'pointer',
                            background: f.hasTypeConflict ? '#ea580c0a' : 'transparent',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = f.hasTypeConflict ? '#ea580c18' : 'var(--surface-hover)')}
                          onMouseLeave={e => (e.currentTarget.style.background = f.hasTypeConflict ? '#ea580c0a' : 'transparent')}
                        >
                          <td style={{ padding: '7px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {f.hasTypeConflict && (
                                <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                              )}
                              <code style={{ fontSize: 12, color: 'var(--text-bright)' }}>{f.path}</code>
                              {expanded
                                ? <ChevronUp size={13} style={{ color: 'var(--text-muted)', marginLeft: 2 }} />
                                : <ChevronDown size={13} style={{ color: 'var(--text-muted)', marginLeft: 2 }} />
                              }
                            </div>
                          </td>
                          <td style={{ padding: '7px 10px' }}>
                            <PresenceBar pct={f.presencePct} />
                          </td>
                          <td style={{ padding: '7px 10px' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                              {f.types.map(t => (
                                <TypeBadge key={t.bsonType} type={t.bsonType} pct={t.pct} />
                              ))}
                            </div>
                            {expanded && f.types.length > 1 && (
                              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                                {f.types.map(t => `${t.bsonType}: ${t.count} 条 (${t.pct.toFixed(1)}%)`).join('  ·  ')}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 12 }}>
                            {f.sampleValues.join('  ·  ')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{
        fontSize: 20, fontWeight: 600,
        color: warn ? '#ea580c' : 'var(--text-bright)',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );
}
