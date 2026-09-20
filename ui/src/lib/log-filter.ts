import { parseAnsi, type AnsiState } from "./ansi-parser";

export type LogLine = {
  plainText: string;
  segments: ReturnType<typeof parseAnsi>["segments"];
};

export function compileLogFilter(query: string) {
  const normalized = query.toLocaleLowerCase();
  return {
    test: (text: string) => text.toLocaleLowerCase().includes(normalized),
  };
}

export function matchLogText(text: string, query: string) {
  return { matches: compileLogFilter(query).test(text) };
}

/** Transport chunks are not lines: retain partial lines and ANSI escapes. */
export class LogBuffer {
  private completed: LogLine[] = [];
  private pending = "";
  private state: AnsiState = {};

  append(chunk: string) {
    const parts = (this.pending + chunk).split("\n");
    this.pending = parts.pop() || "";
    for (const part of parts) {
      const parsed = parseAnsi(part.replace(/\r$/, ""), this.state);
      this.state = parsed.finalState;
      this.completed.push({
        plainText: parsed.segments.map((s) => s.text).join(""),
        segments: parsed.segments,
      });
    }
  }

  get lines(): LogLine[] {
    if (!this.pending) return this.completed;
    // Do not display an incomplete SGR escape until the next chunk completes it.
    const text = this.pending.replace(/\u001b(?:\[[0-9;]*)?$/, "");
    if (!text) return this.completed;
    const parsed = parseAnsi(text, this.state);
    return [
      ...this.completed,
      {
        plainText: parsed.segments.map((s) => s.text).join(""),
        segments: parsed.segments,
      },
    ];
  }

  get text() {
    const text = this.lines.map((line) => line.plainText).join("\n");
    return text + (!this.pending && this.completed.length ? "\n" : "");
  }

  clear() {
    this.completed = [];
    this.pending = "";
    this.state = {};
  }
}
