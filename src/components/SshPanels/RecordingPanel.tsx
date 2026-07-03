// 会话录制与回放面板
// 录制：订阅 xterm.js onData 事件，带时间戳存储输出帧；回放：按帧间隔重放
import { useState, useEffect, useRef } from 'react'
import { Circle, Square, Play, SkipBack, Trash2, Download, X as XIcon, Video } from 'lucide-react'

interface Frame {
  t: number   // ms 相对时间戳
  d: string   // 输出数据
}

interface Recording {
  id: string
  name: string
  startedAt: number
  durationMs: number
  frames: Frame[]
}

interface Props {
  sessionId: string
  onClose: () => void
}

const STORAGE_KEY = 'dbterm-recordings'

function loadRecordings(): Recording[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') }
  catch { return [] }
}
function saveRecordings(list: Recording[]) {
  // 只保留最近 20 条，每条限 1MB
  const limited = list.slice(-20)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(limited)) } catch { /* quota */ }
}

// 全局录制状态（跨面板关闭/打开保持）
const activeRecordings: Map<string, { start: number; frames: Frame[] }> = new Map()

export function startRecording(sessionId: string) {
  activeRecordings.set(sessionId, { start: Date.now(), frames: [] })
}
export function stopRecording(sessionId: string): Frame[] {
  const rec = activeRecordings.get(sessionId)
  activeRecordings.delete(sessionId)
  return rec?.frames ?? []
}
export function addFrame(sessionId: string, data: string) {
  const rec = activeRecordings.get(sessionId)
  if (!rec) return
  rec.frames.push({ t: Date.now() - rec.start, d: data })
}
export function isRecording(sessionId: string) {
  return activeRecordings.has(sessionId)
}

export default function RecordingPanel({ sessionId, onClose }: Props) {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [recording, setRecording] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playPos, setPlayPos] = useState(0)
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(1)
  const [recName, setRecName] = useState('')
  const playRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameIdxRef = useRef(0)

  useEffect(() => { speedRef.current = speed }, [speed])

  useEffect(() => {
    setRecordings(loadRecordings())
    setRecording(isRecording(sessionId))
    return () => { if (playRef.current) clearTimeout(playRef.current) }
  }, [sessionId])

  function startRec() {
    startRecording(sessionId)
    setRecording(true)
  }

  function stopRec() {
    const frames = stopRecording(sessionId)
    setRecording(false)
    if (!frames.length) return
    const name = recName.trim() || new Date().toLocaleString('zh-CN', { hour12: false })
    const rec: Recording = {
      id: String(Date.now()),
      name,
      startedAt: Date.now(),
      durationMs: frames[frames.length - 1]?.t ?? 0,
      frames,
    }
    const updated = [...recordings, rec]
    setRecordings(updated)
    saveRecordings(updated)
    setRecName('')
  }

  function deleteRec(id: string) {
    const updated = recordings.filter(r => r.id !== id)
    setRecordings(updated)
    saveRecordings(updated)
    if (playingId === id) stopPlay()
  }

  function stopPlay() {
    if (playRef.current) clearTimeout(playRef.current)
    setPlayingId(null)
    setPlayPos(0)
    frameIdxRef.current = 0
  }

  function playRecording(rec: Recording) {
    if (playRef.current) clearTimeout(playRef.current)
    setPlayingId(rec.id)
    setPlayPos(0)
    frameIdxRef.current = 0
    scheduleNext(rec, 0, Date.now())
  }

  function scheduleNext(rec: Recording, idx: number, wallStart: number) {
    if (idx >= rec.frames.length) {
      setPlayingId(null); setPlayPos(rec.durationMs); return
    }
    const frame = rec.frames[idx]
    const target = frame.t / speedRef.current
    const elapsed = Date.now() - wallStart
    const delay = Math.max(0, target - elapsed)
    playRef.current = setTimeout(() => {
      frameIdxRef.current = idx + 1
      setPlayPos(frame.t)
      // 触发 xterm 写入（通过自定义事件）
      window.dispatchEvent(new CustomEvent('dbterm-replay-frame', {
        detail: { sessionId, data: frame.d }
      }))
      scheduleNext(rec, idx + 1, wallStart)
    }, delay)
  }

  function exportCast(rec: Recording) {
    // asciicast v2 格式（基础版）
    const header = JSON.stringify({ version: 2, width: 220, height: 50, timestamp: Math.floor(rec.startedAt / 1000), title: rec.name })
    const lines = [header, ...rec.frames.map(f => JSON.stringify([f.t / 1000, 'o', f.d]))]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${rec.name.replace(/[^a-z0-9一-鿿]/gi, '_')}.cast`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function fmtDur(ms: number) {
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
  }

  const btnBase: React.CSSProperties = {
    padding: '4px 6px', borderRadius: 5, border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <Video size={14} color="var(--accent)" />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)', flex: 1 }}>会话录制</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px', color: 'var(--text-muted)', display: 'flex' }}>
          <XIcon size={14} />
        </button>
      </div>

      {/* 录制控制 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        {!recording ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={recName} onChange={e => setRecName(e.target.value)}
              placeholder="录制名称（可选）"
              style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
            <button onClick={startRec}
              style={{ ...btnBase, background: '#dc2626', color: '#fff', padding: '5px 10px' }}>
              <Circle size={11} /> 开始录制
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#dc2626', animation: 'pulse 1s infinite' }} />
              <span style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>录制中…</span>
            </div>
            <button onClick={stopRec}
              style={{ ...btnBase, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}>
              <Square size={11} /> 停止
            </button>
          </div>
        )}
      </div>

      {/* 录制列表 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {recordings.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            <Video size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
            <div>还没有录制</div>
          </div>
        )}
        {recordings.slice().reverse().map(rec => {
          const isPlaying = playingId === rec.id
          const progress = rec.durationMs > 0 ? (playPos / rec.durationMs) * 100 : 0
          return (
            <div key={rec.id} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtDur(rec.durationMs)}</span>
              </div>
              {isPlaying && (
                <div style={{ height: 3, background: 'var(--surface-2)', borderRadius: 2, marginBottom: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--accent)', width: `${progress}%`, transition: 'width 0.2s' }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {!isPlaying ? (
                  <button onClick={() => playRecording(rec)} style={{ ...btnBase, background: 'var(--accent)', color: '#fff' }}>
                    <Play size={11} /> 回放
                  </button>
                ) : (
                  <>
                    <button onClick={stopPlay} style={{ ...btnBase, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                      <SkipBack size={11} /> 停止
                    </button>
                    <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
                      style={{ fontSize: 11, padding: '3px 5px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1x</option>
                      <option value={2}>2x</option>
                      <option value={4}>4x</option>
                    </select>
                  </>
                )}
                <button onClick={() => exportCast(rec)} style={{ ...btnBase, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', marginLeft: 'auto' }}>
                  <Download size={11} /> .cast
                </button>
                <button onClick={() => deleteRec(rec.id)} style={{ ...btnBase, background: 'none', color: '#dc2626' }}>
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        录制内容存于本地，导出为 .cast 文件可用 asciinema 播放器回放。
      </div>
    </div>
  )
}
