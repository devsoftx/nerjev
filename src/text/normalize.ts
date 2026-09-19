import type { PageSpan } from "../types.js";

export interface RawPage {
  page: number;
  text: string;
}

export interface NormalizedText {
  text: string;
  pageMap: PageSpan[];
}

/** A first or last line seen on this share of pages is treated as a running header or footer. */
const REPEAT_SHARE = 0.5;
const MIN_PAGES_FOR_REPEAT = 3;

const ENDS_SENTENCE = /[.!?:;"'”’)\]]$/;

/** Digits vary between pages ("Page 3 of 12"), so they are masked before lines are compared. */
const signature = (line: string) => line.trim().replace(/\d+/g, "#").toLowerCase();

function findRunningLines(pages: string[][]): Set<string> {
  if (pages.length < MIN_PAGES_FOR_REPEAT) return new Set();
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edges = new Set([lines[0], lines[lines.length - 1]].filter(Boolean).map((l) => signature(l!)));
    for (const edge of edges) counts.set(edge, (counts.get(edge) ?? 0) + 1);
  }
  const threshold = Math.max(MIN_PAGES_FOR_REPEAT, Math.ceil(pages.length * REPEAT_SHARE));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([sig]) => sig));
}

/** A line this much shorter than the page's longest line, with no closing punctuation, is a heading. */
const HEADING_MAX_SHARE = 0.6;

/**
 * Headings carry no full stop, so once lines are unwrapped "Item 10" would fuse with the sentence
 * after it. A short unpunctuated line followed by a capitalized line gets a paragraph break instead.
 */
function separateHeadings(lines: string[]): string[] {
  const longest = Math.max(0, ...lines.map((line) => line.trim().length));
  const out: string[] = [];
  lines.forEach((line, i) => {
    out.push(line);
    const text = line.trim();
    const next = lines[i + 1]?.trim() ?? "";
    const isHeading = text.length > 0 && text.length < longest * HEADING_MAX_SHARE && !/[.!?,;:\-]$/.test(text) && /^[\p{Lu}\p{N}]/u.test(next);
    if (isHeading) out.push("");
  });
  return out;
}

function normalizePage(lines: string[]): string {
  return (
    separateHeadings(lines)
      .join("\n")
      // a word hyphenated across a line break
      .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
      // a compound broken at its own hyphen ("Al-" / "Qaida") keeps the hyphen and loses the break
      .replace(/(\p{L})-\n(\p{Lu})/gu, "$1-$2")
      // blank lines are paragraph breaks; protect them, then unwrap the hard line breaks left
      .replace(/\n\s*\n+/g, "\u0000")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\u0000/g, "\n\n")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ ?\n\n ?/g, "\n\n")
      .trim()
  );
}

export function normalizePages(pages: RawPage[]): NormalizedText {
  const split = pages.map((p) =>
    p.text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd()),
  );
  const nonEmpty = split.map((lines) => lines.filter((line) => line.trim().length > 0));
  const running = findRunningLines(nonEmpty);

  let text = "";
  const pageMap: PageSpan[] = [];
  pages.forEach((page, i) => {
    const lines = split[i]!.slice();
    const drop = (index: number) => {
      const line = lines[index];
      if (line !== undefined && line.trim() && running.has(signature(line))) lines.splice(index, 1);
    };
    while (lines.length && !lines[0]!.trim()) lines.shift();
    drop(0);
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    drop(lines.length - 1);

    const body = normalizePage(lines);
    if (!body) return;
    if (text) {
      // A page break in the middle of a sentence must not end the sentence.
      if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(body)) text = text.slice(0, -1);
      else text += ENDS_SENTENCE.test(text) ? "\n\n" : " ";
    }
    const start = text.length;
    text += body;
    pageMap.push({ page: page.page, start, end: text.length });
  });
  return { text, pageMap };
}

/** The page holding a document offset. Offsets in the gap between pages belong to the next page. */
export function pageAt(pageMap: PageSpan[], offset: number): number {
  for (const span of pageMap) if (offset < span.end) return span.page;
  return pageMap[pageMap.length - 1]?.page ?? 1;
}
