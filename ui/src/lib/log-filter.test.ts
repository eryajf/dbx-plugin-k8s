import { describe, expect, it } from "vitest";

import { matchLogText } from "./log-filter";

describe("matchLogText", () => {
  it("matches plain text case-insensitively", () => {
    expect(matchLogText("Worker started", "worker").matches).toBe(true);
    expect(matchLogText("Worker started", "error").matches).toBe(false);
  });

  it("treats regular expression characters as literal text", () => {
    expect(matchLogText("request 503", "request.*").matches).toBe(false);
    expect(matchLogText("[error]", "[").matches).toBe(true);
  });
});

import { LogBuffer, compileLogFilter } from "./log-filter";
import { normalizeLogTheme } from "./log-theme";

describe("streamed log buffer", () => {
  it("counts real lines and joins fragments without synthetic newlines", () => {
    const buffer = new LogBuffer();
    buffer.append("one\ntw");
    buffer.append("o\nthree\n");
    expect(buffer.lines.map((line) => line.plainText)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(buffer.text).toBe("one\ntwo\nthree\n");
    buffer.clear();
    expect(buffer.lines).toEqual([]);
  });
  it("retains blank lines and an unfinished final line", () => {
    const buffer = new LogBuffer();
    buffer.append("one\r\n\nlast");
    expect(buffer.lines.map((line) => line.plainText)).toEqual([
      "one",
      "",
      "last",
    ]);
  });
  it("preserves ANSI across lines and fragmented escape sequences", () => {
    const buffer = new LogBuffer();
    buffer.append("\u001b[3");
    expect(buffer.lines).toEqual([]);
    buffer.append("1mred\nred again\u001b[0m\nplain");
    expect(buffer.lines[0].segments[0].styles.color).toBe("#cd3131");
    expect(buffer.lines[1].segments[0].styles.color).toBe("#cd3131");
    expect(buffer.lines[2].segments[0].styles.color).toBeUndefined();
    expect(buffer.text).toBe("red\nred again\nplain");
  });
  it("filters per line and retains nonmatching data for export", () => {
    const buffer = new LogBuffer();
    buffer.append("error 500\ninfo 200\nerror 503\n");
    const filter = compileLogFilter("error");
    expect(
      buffer.lines.filter((line) => filter.test(line.plainText)),
    ).toHaveLength(2);
    expect(buffer.text).toContain("info 200");
  });
  it("uses literal matching by default and accepts empty filters", () => {
    expect(matchLogText("anything", ".*").matches).toBe(false);
    expect(matchLogText("anything", "").matches).toBe(true);
  });
  it("normalizes old, new and corrupt theme preferences", () => {
    expect(normalizeLogTheme("github")).toBe("github");
    expect(normalizeLogTheme("matrix")).toBe("matrix");
    expect(normalizeLogTheme("classic")).toBe("classic");
    expect(normalizeLogTheme("dark")).toBe("classic");
    expect(normalizeLogTheme("dbx")).toBe("classic");
  });
});
