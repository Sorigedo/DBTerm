// MO10.7: MongoDB 多文档事务面板（副本集专属）
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Play, Check, XCircle, AlertTriangle, Terminal, Trash2 } from 'lucide-react';

interface CmdRecord {
  id: number;
  cmd: string;
  result: string;
  ok: boolean;
  ts: number;
}

interface Props {
  connId: string;
  currentDb: string;
  onClose: () => void;
}

export default function MongoTxPanel({ connId, currentDb, onClose }: Props) {
  const [txId, setTxId]           = useState<string | null>(null);
  const [cmdInput, setCmdInput]   = useState('{\n  "insert": "test",\n  "documents": [{"x": 1}]\n}');
  const [db, setDb]               = useState(currentDb);
  const [history, setHistory]     = useState<CmdRecord[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [confirmAbort, setConfirmAbort] = useState(false);
  const seqRef = useRef(1);

  async function begin() {
    setLoading(true);
    setError('');
    try {
      const id = await invoke<string>('mongo_tx_begin', { id: connId, db });
      setTxId(id);
      setHistory([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function exec() {
    if (!txId) return;
    setLoading(true);
    setError('');
    const cmd = cmdInput.trim();
    const recId = seqRef.current++;
    try {
      const result = await invoke<string>('mongo_tx_exec', { txId, db, cmdJson: cmd });
      setHistory(prev => [...prev, { id: recId, cmd, result, ok: true, ts: Date.now() }]);
    } catch (e) {
      const errStr = String(e);
      setHistory(prev => [...prev, { id: recId, cmd, result: errStr, ok: false, ts: Date.now() }]);
      setError(errStr);
    } finally {
      setLoading(false);
    }
  }

  async function commit() {
    if (!txId) return;
    setLoading(true);
    setError('');
    try {
      await invoke('mongo_tx_commit', { txId });
      setHistory(prev => [...prev, {
        id: seqRef.current++, cmd: '-- COMMIT', result: '事务已提交', ok: true, ts: Date.now(),
      }]);
      setTxId(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function abort() {
    if (!txId) return;
    setLoading(true);
    setError('');
    try {
      await invoke('mongo_tx_abort', { txId });
      setHistory(prev => [...prev, {
        id: seqRef.current++, cmd: '-- ABORT', result: '事务已回滚', ok: false, ts: Date.now(),
      }]);
      setTxId(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setConfirmAbort(false);
    }
  }

  const cmdCount = history.filter(h => !h.cmd.startsWith('--')).length;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: 60,
    }}>
      <div style={{
        width: 700, maxHeight: 'calc(100vh - 100px)',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Terminal size={16} style={{ color: 'var(--accent)' }} />
            <span style={{ fontWeight: 600, fontSize: 15 }}>多文档事务</span>
            {txId ? (
              <span style={{
                background: '#16a34a22', color: 'var(--success)', border: '1px solid #16a34a44',
                borderRadius: 4, padding: '1px 8px', fontSize: 11,
              }}>
                活跃 · {txId} · {cmdCount} 条命令
              </span>
            ) : (
              <span style={{
                background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 8px', fontSize: 11,
              }}>
                未开始
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        {/* 副本集提示 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 18px', background: 'color-mix(in srgb, var(--accent) 9%, transparent)', borderBottom: '1px solid var(--border-subtle)',
          fontSize: 12, color: 'var(--accent)',
        }}>
          <AlertTriangle size={12} />
          多文档事务仅在 MongoDB 4.0+ 副本集或分片集群上可用，单机实例不支持
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          {/* 控制区 */}
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: txId ? 0 : 8 }}>
              {!txId ? (
                <>
                  <label style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>默认库</label>
                  <input
                    value={db}
                    onChange={e => setDb(e.target.value)}
                    style={{
                      flex: 1, padding: '5px 10px',
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 6, fontSize: 13, color: 'var(--text)',
                    }}
                    placeholder="数据库名"
                  />
                  <button
                    onClick={begin}
                    disabled={loading || !db.trim()}
                    style={{
                      padding: '5px 18px', borderRadius: 8, border: 'none',
                      background: 'var(--accent)', color: '#fff', cursor: 'pointer',
                      fontSize: 13, opacity: loading ? 0.6 : 1,
                    }}
                  >
                    BEGIN
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={commit}
                    disabled={loading}
                    style={{
                      padding: '5px 18px', borderRadius: 8, border: 'none',
                      background: '#16a34a', color: '#fff', cursor: 'pointer',
                      fontSize: 13, display: 'flex', alignItems: 'center', gap: 5,
                    }}
                  >
                    <Check size={13} /> COMMIT
                  </button>
                  {confirmAbort ? (
                    <>
                      <span style={{ fontSize: 13, color: 'var(--error)' }}>确认回滚？</span>
                      <button
                        onClick={abort}
                        disabled={loading}
                        style={{
                          padding: '5px 14px', borderRadius: 8, border: 'none',
                          background: 'var(--error)', color: '#fff', cursor: 'pointer', fontSize: 13,
                        }}
                      >
                        确认 ABORT
                      </button>
                      <button
                        onClick={() => setConfirmAbort(false)}
                        style={{
                          padding: '5px 14px', borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13,
                        }}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmAbort(true)}
                      style={{
                        padding: '5px 14px', borderRadius: 8, border: '1px solid #dc2626',
                        background: 'transparent', color: 'var(--error)', cursor: 'pointer',
                        fontSize: 13, display: 'flex', alignItems: 'center', gap: 5,
                      }}
                    >
                      <XCircle size={13} /> ABORT
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 命令输入 */}
          {txId && (
            <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                命令 JSON（在事务内执行，如 insert / update / delete / findAndModify）
              </div>
              <textarea
                value={cmdInput}
                onChange={e => setCmdInput(e.target.value)}
                rows={5}
                style={{
                  width: '100%', padding: '8px 10px',
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 6, fontSize: 12, color: 'var(--text)',
                  fontFamily: 'var(--font-mono, monospace)', resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button
                  onClick={exec}
                  disabled={loading || !cmdInput.trim()}
                  style={{
                    padding: '5px 18px', borderRadius: 8, border: 'none',
                    background: 'var(--accent)', color: '#fff', cursor: 'pointer',
                    fontSize: 13, display: 'flex', alignItems: 'center', gap: 5,
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  <Play size={13} /> 执行
                </button>
              </div>
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div style={{
              margin: '8px 18px 0',
              background: '#dc262622', border: '1px solid #dc2626',
              borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--error)',
            }}>
              {error}
            </div>
          )}

          {/* 执行历史 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px' }}>
            {history.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>
                {txId ? '请在上方输入命令并执行' : '点击 BEGIN 开启事务'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {history.map(rec => (
                  <div key={rec.id} style={{
                    background: 'var(--surface-2)', borderRadius: 8,
                    border: `1px solid ${rec.ok ? 'var(--border)' : '#dc262644'}`,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)',
                      background: rec.cmd.startsWith('--') ? (rec.ok ? '#16a34a18' : '#dc262618') : 'transparent',
                    }}>
                      {rec.ok
                        ? <Check size={12} style={{ color: 'var(--success)' }} />
                        : <XCircle size={12} style={{ color: 'var(--error)' }} />
                      }
                      <code style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                        {rec.cmd.length > 80 ? rec.cmd.slice(0, 80) + '…' : rec.cmd}
                      </code>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {new Date(rec.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <pre style={{
                      margin: 0, padding: '6px 10px', fontSize: 11,
                      color: rec.ok ? 'var(--text)' : '#dc2626',
                      maxHeight: 120, overflowY: 'auto',
                      fontFamily: 'var(--font-mono, monospace)',
                    }}>
                      {rec.result}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 底部 */}
        {history.length > 0 && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 18px', borderTop: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {cmdCount} 条命令
            </span>
            <button
              onClick={() => setHistory([])}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 12,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Trash2 size={11} /> 清空记录
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
