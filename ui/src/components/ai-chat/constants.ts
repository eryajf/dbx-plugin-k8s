export const AI_CHAT_TOGGLE_EVENT = 'kite:ai-chat-toggle'

export function getAIChatShortcutLabel() {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) {
    return '⌘⇧A'
  }
  return 'Ctrl+Shift+A'
}
