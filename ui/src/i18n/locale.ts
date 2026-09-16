/** Canonical DBX locales. Keep aliases at the boundary, never in resource files. */
export const languages = [
  { code: 'en', name: 'English' },
  { code: 'az', name: 'Azərbaycan' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'pt-BR', name: 'Português' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
] as const

export type SupportedLocale = (typeof languages)[number]['code']

export function normalizeLocale(value?: string): SupportedLocale {
  const locale = value?.trim().replace(/_/g, '-').toLowerCase() ?? ''
  const parts = locale.split('-')
  if (parts[0] === 'zh') {
    return parts.includes('hant') ||
      parts.includes('tw') ||
      parts.includes('hk') ||
      parts.includes('mo')
      ? 'zh-TW'
      : 'zh-CN'
  }
  if (parts[0] === 'pt') return 'pt-BR'
  return languages.find(({ code }) => code === parts[0])?.code ?? 'en'
}
