export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  const d = new Date(ts)
  const m = d.getMonth() + 1
  const dayOfMonth = d.getDate()
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${m}/${dayOfMonth}`
    : `${d.getFullYear()}/${m}/${dayOfMonth}`
}

// Compact wall-clock duration for tool messages. Returns '' for missing/invalid
// input so callers can render unconditionally.
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
}
