import { useEffect, useState } from 'react'
import type { Invoke } from './types'
import { metricValue } from './metrics'
import './metrics-panel.css'

type Item = { metadata?: { name?: string; namespace?: string }; timestamp?: string; usage?: Record<string, string>; containers?: { usage?: Record<string, string> }[] }
type Row = { name: string; cpu: number; memory: number }
type Sample = { at: number; cpu: number; memory: number }
export function metricsRows(items: Item[]): Row[] {
  return items.map(item => {
    const usages = item.containers?.map(c => c.usage || {}) || [item.usage || {}]
    return { name: [item.metadata?.namespace, item.metadata?.name].filter(Boolean).join('/'), cpu: usages.reduce((n, u) => n + metricValue(u.cpu, 'cpu'), 0), memory: usages.reduce((n, u) => n + metricValue(u.memory, 'memory'), 0) }
  }).sort((a, b) => b.cpu - a.cpu)
}
function Chart({ samples, field, label }: { samples: Sample[]; field: 'cpu' | 'memory'; label: string }) {
  const max = Math.max(...samples.map(s => s[field]), 0.001)
  const start = samples[0]?.at || 0
  const duration = Math.max(1, (samples[samples.length - 1]?.at || 0) - start)
  const points = samples.map(s => `${10 + (s.at - start) / duration * 480},${90 - s[field] / max * 80}`).join(' ')
  return <figure><figcaption>{label} · {samples[samples.length - 1]?.[field].toFixed(field === 'cpu' ? 0 : 2) || '0'} {field === 'cpu' ? 'mCPU' : 'GiB'}</figcaption><svg role="img" aria-label={label} viewBox="0 0 500 110"><path d="M10 10V90H490" fill="none" stroke="currentColor" opacity=".25"/><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2"/>{samples.length === 1 && <circle cx="10" cy="10" r="3" fill="currentColor"/>}<text x="10" y="107" fontSize="10" fill="currentColor">{start ? new Date(start).toLocaleTimeString() : ''}</text><text x="490" y="107" textAnchor="end" fontSize="10" fill="currentColor">{samples.length > 1 ? new Date(samples[samples.length - 1]!.at).toLocaleTimeString() : ''}</text></svg></figure>
}
export function MetricsPanel({ invoke, zh }: { invoke: Invoke; zh: boolean }) {
  const [kind, setKind] = useState('nodes')
  const [period, setPeriod] = useState(30)
  const [minutes, setMinutes] = useState(15)
  const [reload, setReload] = useState(0)
  const [rows, setRows] = useState<Row[]>([])
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<number | null>(null)
  const t = (cn: string, en: string) => zh ? cn : en
  useEffect(() => { setRows([]); setSamples([]); setLast(null) }, [kind, invoke])
  useEffect(() => {
    let live = true
    let active = false
    async function refresh() {
      if (active) return
      active = true; setBusy(true)
      try {
        const result = await invoke<{ items: Item[] }>('kube/metrics', { resource: kind })
        if (!live) return
        const next = metricsRows(result.items || [])
        const at = Date.now()
        setRows(next); setLast(at); setError('')
        // Keep bounded session samples; Metrics API does not provide server history.
        if (next.length) setSamples(old => [...old.filter(s => s.at > at - 60 * 60 * 1000), { at, cpu: next.reduce((n, r) => n + r.cpu, 0), memory: next.reduce((n, r) => n + r.memory, 0) }].slice(-720))
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)) }
      finally { active = false; if (live) setBusy(false) }
    }
    void refresh()
    const timer = period ? window.setInterval(() => void refresh(), period * 1000) : undefined
    return () => { live = false; window.clearInterval(timer) }
  }, [invoke, kind, period, reload])
  const visible = samples.filter(s => s.at >= (last || Date.now()) - minutes * 60 * 1000)
  return <section className="wb-metrics-panel" aria-label="Resource metrics"><h2>{t('资源指标', 'Resource metrics')}</h2><div className="wb-toolbar"><select aria-label="Metrics resource" value={kind} onChange={e => setKind(e.target.value)}><option value="nodes">{t('节点', 'Nodes')}</option><option value="pods">{t('容器组', 'Pods')}</option></select><select aria-label="Metrics refresh" value={period} onChange={e => setPeriod(Number(e.target.value))}>{[0, 5, 10, 30, 60].map(n => <option key={n} value={n}>{n ? `${n}s` : t('手动刷新', 'Manual refresh')}</option>)}</select><select aria-label="Metrics history" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[5, 15, 60].map(n => <option key={n} value={n}>{n} min</option>)}</select><button disabled={busy} onClick={() => setReload(n => n + 1)}>{t('刷新指标', 'Refresh metrics')}</button><button disabled={!samples.length} onClick={() => setSamples([])}>{t('清除趋势', 'Clear history')}</button></div><p>{t('趋势仅记录本次打开页面期间的采样，数据来自 Kubernetes Metrics API。', 'Trends contain samples collected while this page is open, from Kubernetes Metrics API.')}</p>{error && <p role="alert">{t('指标读取失败', 'Metrics unavailable')}: {error}{last && ` · ${t('仍显示上次成功的数据', 'Showing last successful data')}`}</p>}{last && <small>{t('更新时间', 'Updated')}: {new Date(last).toLocaleTimeString()}</small>}<div className="wb-metrics-charts"><Chart samples={visible} field="cpu" label="CPU"/><Chart samples={visible} field="memory" label={t('内存', 'Memory')}/></div><div className="wb-metric-table"><table><thead><tr><th>{kind === 'nodes' ? t('节点', 'Node') : t('命名空间 / 容器组', 'Namespace / Pod')}</th><th>CPU (m)</th><th>{t('内存', 'Memory')} (GiB)</th></tr></thead><tbody>{rows.map(row => <tr key={row.name}><td>{row.name}</td><td>{row.cpu.toFixed(0)}</td><td>{row.memory.toFixed(2)}</td></tr>)}</tbody></table>{!busy && !rows.length && <p>{t('暂无指标数据', 'No metric data')}</p>}</div></section>
}
