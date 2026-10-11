import { formatMemory } from '@/lib/utils'

export function formatCompactMemoryValue(value: number): string {
  const formatted = formatMemory(value)
  const match = formatted.match(/^(\d+(?:\.\d+)?)\s([A-Za-z]+)$/)

  if (!match) {
    return formatted
  }

  const numericValue = Number(match[1])
  if (!Number.isFinite(numericValue)) {
    return formatted
  }

  const digits = numericValue >= 100 ? 0 : 1

  return `${numericValue.toFixed(digits).replace(/\.0$/, '')} ${match[2]}`
}

export function formatCpuCoreValue(
  value: number,
  coreUnitLabel: string
): string {
  const cores = value / 1000

  if (!Number.isFinite(cores)) {
    return `- ${coreUnitLabel}`
  }

  if (cores >= 10) {
    return `${Math.round(cores)} ${coreUnitLabel}`
  }

  if (cores >= 1) {
    return `${Number(cores.toFixed(1))} ${coreUnitLabel}`
  }

  return `${Number(cores.toFixed(1))} ${coreUnitLabel}`
}
