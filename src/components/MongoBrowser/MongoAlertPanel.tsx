// MO10.4: MongoDB 告警阈值配置面板
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Bell, BellOff, AlertTriangle, CheckCircle } from 'lucide-react';
import { toast } from '../../stores/toastStore';

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface MongoAlertThresholds {
  enabled: boolean;
  intervalSec: number;
  // 连接数
  connectionsWarn: number;
  connectionsError: number;
  // WiredTiger 缓存命中率（%）
  cacheHitWarn: number;
  // 复制延迟（秒）
  replLagWarn: number;
  replLagError: number;
  // oplog 窗口（小时）
  oplogWindowWarn: number;
}

export interface MongoAlertState {
  hasAlert: boolean;     // 是否有任意告警（供红点显示）
  lastCheck: number;     // unix ms
  alerts: string[];      // 当前未清除的告警描述
}

// ── localStorage 辅助 ───────────────────────────────────────────────────────

const KEY = (id: string) => `dbterm_mongo_alerts_${id}`;

const DEFAULTS: MongoAlertThresholds = {
  enabled: false,
  intervalSec: 60,
  connectionsWarn: 500,
  connectionsError: 800,
  cacheHitWarn: 85,
  replLagWarn: 30,
  replLagError: 120,
  oplogWindowWarn: 24,
};

export function loadAlertThresholds(connId: string): MongoAlertThresholds {
  try {
    const raw = localStorage.getItem(KEY(connId));
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function saveAlertThresholds(connId: string, t: MongoAlertThresholds): void {
  localStorage.setItem(KEY(connId), JSON.stringify(t));
}

// ── 解析 serverStatus JSON ───────────────────────────────────────────────────

interface ParsedMetrics {
  connections: number;
  cacheHitPct: number;  // 0~100, -1 = 无数据
}

function parseServerStatus(json: string): ParsedMetrics {
  try {
    const d = JSON.parse(json);
    const connections = (d?.connections?.current as number | undefined) ?? 0;
    // WiredTiger 缓存命中率
    const wt = d?.wiredTiger?.cache;
    let cacheHitPct = -1;
    if (wt) {
      const read = (wt['pages read into cache'] as number | undefined) ?? 0;
      const hits = (wt['pages requested from the cache'] as number | undefined) ?? 0;
      const req  = hits + read;
      cacheHitPct = req > 0 ? (hits / req) * 100 : -1;
    }
    return { connections, cacheHitPct };
  } catch {
    return { connections: 0, cacheHitPct: -1 };
  }
}

// ── 解析 replSetGetStatus ────────────────────────────────────────────────────

function parseReplLag(json: string): number {
  // -1 = 不是副本集或无法判断
  try {
    const d = JSON.parse(json);
    if (!d?.members) return -1;
    const primary = d.members.find((m: Record<string, unknown>) => m.stateStr === 'PRIMARY');
    if (!primary) return -1;
    const primaryOptime = (primary.optimeDate as { $date?: { $numberLong?: string } })?.$date?.$numberLong;
    const primaryMs = primaryOptime ? Number(primaryOptime) : 0;
    let maxLagSec = 0;
    for (const m of d.members) {
      if ((m as Record<string, unknown>).stateStr === 'PRIMARY') continue;
      const mOptime = ((m as Record<string, unknown>).optimeDate as { $date?: { $numberLong?: string } })?.$date?.$numberLong;
      const mMs = mOptime ? Number(mOptime) : 0;
      if (primaryMs > mMs) {
        maxLagSec = Math.max(maxLagSec, (primaryMs - mMs) / 1000);
      }
    }
    return maxLagSec;
  } catch {
    return -1;
  }
}

// ── 轮询 Hook ────────────────────────────────────────────────────────────────

export function useMongoAlerts(
  connId: string,
  thresholds: MongoAlertThresholds,
  onAlertState: (s: MongoAlertState) => void,
) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef<Set<string>>(new Set());
  // BUG-4 fix: 用 ref 存 callback，避免 onAlertState 引用变化导致 effect 不断重置定时器
  const onAlertStateRef = useRef(onAlertState);
  useEffect(() => { onAlertStateRef.current = onAlertState; });

  const check = useCallback(async () => {
    if (!thresholds.enabled) return;
    const alerts: string[] = [];

    // 1. serverStatus
    try {
      const json = await invoke<string>('mongo_server_status', { id: connId });
      const { connections, cacheHitPct } = parseServerStatus(json);

      // 连接数
      if (connections >= thresholds.connectionsError) {
        alerts.push(`连接数严重：${connections} 超过阈值 ${thresholds.connectionsError}`);
        if (!firedRef.current.has('conn_err')) {
          toast.error(`MongoDB [${connId}] 连接数 ${connections} 超过危险阈值`);
          firedRef.current.add('conn_err');
        }
        firedRef.current.delete('conn_warn');
      } else if (connections >= thresholds.connectionsWarn) {
        alerts.push(`连接数警告：${connections} 超过阈值 ${thresholds.connectionsWarn}`);
        if (!firedRef.current.has('conn_warn')) {
          toast.warning(`MongoDB [${connId}] 连接数 ${connections} 超过警告阈值`);
          firedRef.current.add('conn_warn');
        }
        firedRef.current.delete('conn_err');
      } else {
        firedRef.current.delete('conn_warn');
        firedRef.current.delete('conn_err');
      }

      // 缓存命中率
      if (cacheHitPct >= 0 && cacheHitPct < thresholds.cacheHitWarn) {
        alerts.push(`缓存命中率偏低：${cacheHitPct.toFixed(1)}%（阈值 ${thresholds.cacheHitWarn}%）`);
        if (!firedRef.current.has('cache')) {
          toast.warning(`MongoDB [${connId}] WiredTiger 缓存命中率 ${cacheHitPct.toFixed(1)}% 偏低`);
          firedRef.current.add('cache');
        }
      } else {
        firedRef.current.delete('cache');
      }
    } catch { /* 连接断开时静默 */ }

    // 2. replSetGetStatus（忽略不是副本集的错误）
    try {
      const rjson = await invoke<string>('mongo_repl_set_status', { id: connId });
      const lagSec = parseReplLag(rjson);

      if (lagSec >= 0) {
        if (lagSec >= thresholds.replLagError) {
          alerts.push(`复制延迟严重：${lagSec.toFixed(0)}s 超过阈值 ${thresholds.replLagError}s`);
          if (!firedRef.current.has('repl_err')) {
            toast.error(`MongoDB [${connId}] 复制延迟 ${lagSec.toFixed(0)}s 超过危险阈值`);
            firedRef.current.add('repl_err');
          }
          firedRef.current.delete('repl_warn');
        } else if (lagSec >= thresholds.replLagWarn) {
          alerts.push(`复制延迟警告：${lagSec.toFixed(0)}s 超过阈值 ${thresholds.replLagWarn}s`);
          if (!firedRef.current.has('repl_warn')) {
            toast.warning(`MongoDB [${connId}] 复制延迟 ${lagSec.toFixed(0)}s 超过警告阈值`);
            firedRef.current.add('repl_warn');
          }
          firedRef.current.delete('repl_err');
        } else {
          firedRef.current.delete('repl_warn');
          firedRef.current.delete('repl_err');
        }
      }
    } catch { /* 非副本集 */ }

    // 3. oplog 窗口
    try {
      const olog = await invoke<{ windowHours: number } | null>('mongo_oplog_info', { id: connId });
      if (olog && olog.windowHours < thresholds.oplogWindowWarn) {
        alerts.push(`Oplog 窗口偏短：${olog.windowHours.toFixed(1)}h（阈值 ${thresholds.oplogWindowWarn}h）`);
        if (!firedRef.current.has('oplog')) {
          toast.warning(`MongoDB [${connId}] Oplog 窗口仅 ${olog.windowHours.toFixed(1)}h，可能影响恢复`);
          firedRef.current.add('oplog');
        }
      } else {
        firedRef.current.delete('oplog');
      }
    } catch { /* 无 oplog */ }

    onAlertStateRef.current({ hasAlert: alerts.length > 0, lastCheck: Date.now(), alerts });
  }, [connId, thresholds]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!thresholds.enabled) {
      onAlertStateRef.current({ hasAlert: false, lastCheck: 0, alerts: [] });
      return;
    }
    check(); // 立即检查一次
    timerRef.current = setInterval(check, thresholds.intervalSec * 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [thresholds.enabled, thresholds.intervalSec, check]);
}

// ── 配置面板 ─────────────────────────────────────────────────────────────────

interface Props {
  connId: string;
  alertState: MongoAlertState;
  onClose: () => void;
  onSave: (t: MongoAlertThresholds) => void;
}

function NumField({
  label, value, onChange, unit, min, max, step = 1,
}: {
  label: string; value: number; onChange: (v: number) => void;
  unit?: string; min?: number; max?: number; step?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <label style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            width: 80, padding: '4px 8px',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 13, color: 'var(--text)', textAlign: 'right',
          }}
        />
        {/* 单位槽位始终占位（无单位时为空），使各行输入框右边缘对齐 */}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 28, flexShrink: 0 }}>{unit ?? ''}</span>
      </div>
    </div>
  );
}

export default function MongoAlertPanel({ connId, alertState, onClose, onSave }: Props) {
  const [t, setT] = useState<MongoAlertThresholds>(() => loadAlertThresholds(connId));

  function set<K extends keyof MongoAlertThresholds>(k: K, v: MongoAlertThresholds[K]) {
    setT(prev => ({ ...prev, [k]: v }));
  }

  function handleSave() {
    saveAlertThresholds(connId, t);
    onSave(t);
    onClose();
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80,
    }}>
      <div style={{
        width: 520, background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* 标题 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>告警阈值配置</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
          {/* 当前告警状态 */}
          {alertState.lastCheck > 0 && (
            <div style={{
              background: alertState.hasAlert ? '#ea580c18' : '#16a34a18',
              border: `1px solid ${alertState.hasAlert ? '#ea580c' : '#16a34a'}`,
              borderRadius: 8, padding: '10px 14px', marginBottom: 16,
              fontSize: 13,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                color: alertState.hasAlert ? '#ea580c' : '#16a34a',
                fontWeight: 500, marginBottom: alertState.alerts.length ? 6 : 0,
              }}>
                {alertState.hasAlert
                  ? <><AlertTriangle size={14} /> 当前有 {alertState.alerts.length} 项告警</>
                  : <><CheckCircle size={14} /> 实例状态正常</>
                }
              </div>
              {alertState.alerts.map((a, i) => (
                <div key={i} style={{ color: 'var(--warning)', fontSize: 12, paddingLeft: 20 }}>· {a}</div>
              ))}
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                上次检查：{new Date(alertState.lastCheck).toLocaleTimeString()}
              </div>
            </div>
          )}

          {/* 启用开关 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 16, padding: '10px 14px',
            background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {t.enabled ? <Bell size={16} style={{ color: 'var(--accent)' }} /> : <BellOff size={16} style={{ color: 'var(--text-muted)' }} />}
              <span style={{ fontSize: 14, fontWeight: 500 }}>启用告警轮询</span>
            </div>
            <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22 }}>
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={e => set('enabled', e.target.checked)}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span style={{
                position: 'absolute', inset: 0, borderRadius: 11, cursor: 'pointer',
                background: t.enabled ? 'var(--accent)' : 'var(--surface-2)',
                border: `1px solid ${t.enabled ? 'var(--accent)' : 'var(--border)'}`,
                transition: 'background 0.2s',
              }}>
                <span style={{
                  position: 'absolute', left: t.enabled ? 20 : 2, top: 2,
                  width: 16, height: 16, background: '#fff', borderRadius: '50%',
                  transition: 'left 0.2s',
                }} />
              </span>
            </label>
          </div>

          <NumField
            label="轮询间隔"
            value={t.intervalSec}
            onChange={v => set('intervalSec', Math.max(10, v))}
            unit="秒"
            min={10}
          />

          <div style={{ marginTop: 12, marginBottom: 8, fontWeight: 500, fontSize: 13, color: 'var(--text-muted)' }}>
            连接数
          </div>
          <NumField label="警告阈值" value={t.connectionsWarn} onChange={v => set('connectionsWarn', v)} min={1} />
          <NumField label="危险阈值" value={t.connectionsError} onChange={v => set('connectionsError', v)} min={1} />

          <div style={{ marginTop: 12, marginBottom: 8, fontWeight: 500, fontSize: 13, color: 'var(--text-muted)' }}>
            WiredTiger 缓存命中率
          </div>
          <NumField
            label="命中率低于此值告警"
            value={t.cacheHitWarn}
            onChange={v => set('cacheHitWarn', v)}
            unit="%"
            min={0}
            max={100}
          />

          <div style={{ marginTop: 12, marginBottom: 8, fontWeight: 500, fontSize: 13, color: 'var(--text-muted)' }}>
            复制延迟（仅副本集）
          </div>
          <NumField label="警告阈值" value={t.replLagWarn} onChange={v => set('replLagWarn', v)} unit="秒" min={0} />
          <NumField label="危险阈值" value={t.replLagError} onChange={v => set('replLagError', v)} unit="秒" min={0} />

          <div style={{ marginTop: 12, marginBottom: 8, fontWeight: 500, fontSize: 13, color: 'var(--text-muted)' }}>
            Oplog 窗口（仅副本集）
          </div>
          <NumField
            label="窗口低于此值告警"
            value={t.oplogWindowWarn}
            onChange={v => set('oplogWindowWarn', v)}
            unit="小时"
            min={0}
          />
        </div>

        <div style={{
          display: 'flex', gap: 10, justifyContent: 'flex-end',
          padding: '12px 18px', borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--surface-2)',
              color: 'var(--text)', cursor: 'pointer', fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: '6px 16px', borderRadius: 8,
              border: 'none', background: 'var(--accent)',
              color: '#fff', cursor: 'pointer', fontSize: 13,
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
