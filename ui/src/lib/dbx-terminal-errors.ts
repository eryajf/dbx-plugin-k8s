import type { TFunction } from 'i18next'

const inputErrors = {
  INPUT_INCOMPLETE: 'Terminal input was not fully written; reconnect before continuing',
  INPUT_INVALID: 'Invalid terminal input',
  INPUT_QUEUE_FULL: 'Terminal input queue is full; reconnect before continuing',
} as const

export class TerminalInputError extends Error {
  readonly code: keyof typeof inputErrors
  constructor(code: keyof typeof inputErrors) {
    super(inputErrors[code])
    this.code = code
  }
}

// Only plugin-defined codes are translated; remote errors retain their details.
export function translateTerminalInputError(code: unknown, t: TFunction): string | undefined {
  switch (code) {
    case 'INPUT_INCOMPLETE': return t('terminalInputErrors.incomplete')
    case 'INPUT_INVALID': return t('terminalInputErrors.invalid')
    case 'INPUT_QUEUE_FULL': return t('terminalInputErrors.queueFull')
    default: return undefined
  }
}
