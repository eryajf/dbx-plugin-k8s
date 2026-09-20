import type { TerminalTheme } from "@/types/themes";

export type LogViewerTheme = TerminalTheme;
export function normalizeLogTheme(value: unknown): LogViewerTheme {
  const themes: TerminalTheme[] = [
    "classic",
    "matrix",
    "cyberpunk",
    "solarized",
    "monokai",
    "github",
  ];
  return themes.includes(value as TerminalTheme)
    ? (value as TerminalTheme)
    : "classic";
}
