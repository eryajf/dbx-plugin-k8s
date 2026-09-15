const binaryUnits: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }

export function metricValue(value: unknown, kind: 'cpu' | 'memory') {
  const match = String(value || '0').trim().match(/^([0-9.]+)(n|u|m|Ki|Mi|Gi|Ti)?$/)
  if (!match) return 0
  const amount = Number(match[1])
  const unit = match[2] || ''
  if (kind === 'cpu') return unit === 'n' ? amount / 1e6 : unit === 'u' ? amount / 1e3 : unit === 'm' ? amount : amount * 1000
  return amount * (binaryUnits[unit] || 1) / 1024 ** 3
}
