import { describe, expect, it } from "vitest";
import { documentFromText } from "../src/pdf/extract.js";
import { segment } from "../src/text/chunk.js";
import { normalizePages, pageAt } from "../src/text/normalize.js";
import { splitSentences } from "../src/text/sentences.js";
import { isAskable, tokenize } from "../src/text/tokenize.js";

const tokensOf = (text: string) => tokenize(text, splitSentences(text));

describe("tokenize", () => {
  it("keeps offsets that index back into the text", () => {
    const text = "Dr. Maria Chen joined AT&T in the U.S. for $1,315.50 on 2024-05-01.";
    for (const token of tokensOf(text)) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it("keeps abbreviations, initials, ampersand names and numbers whole", () => {
    const texts = tokensOf("Dr. J. K. Rowling met AT&T in the U.S. and paid 1,315.50 at St. Louis.").map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(["Dr.", "J.", "K.", "Rowling", "AT&T", "U.S.", "1,315.50", "St."]));
  });

  it("splits the possessive and the hyphen so names keep clean edges", () => {
    const tokens = tokensOf("Apple's New York-based team met O'Brien.");
    expect(tokens.map((t) => t.text)).toEqual(["Apple", "'s", "New", "York", "-", "based", "team", "met", "O'Brien", "."]);
    expect(tokens.find((t) => t.text === "'s")!.kind).toBe("possessive");
    expect(tokens.filter(isAskable).map((t) => t.text)).not.toContain("'s");
  });
});

describe("splitSentences", () => {
  it("does not break after a title or an initial", () => {
    const text = "Dr. Smith met Mr. J. K. Rowling at Apple Inc. headquarters. They discussed St. Louis. It went well!";
    const sentences = splitSentences(text).map((s) => text.slice(s.start, s.end));
    expect(sentences).toEqual(["Dr. Smith met Mr. J. K. Rowling at Apple Inc. headquarters.", "They discussed St. Louis.", "It went well!"]);
  });
});

describe("normalizePages", () => {
  const page = (n: number, body: string) => ({ page: n, text: `Acme Quarterly Report\n${body}\nPage ${n} of 3` });

  it("drops running headers and footers, unwraps lines and rejoins hyphenated words", () => {
    const { text } = normalizePages([
      page(1, "The com-\npany grew\nquickly.\n\nA new paragraph."),
      page(2, "Second page text."),
      page(3, "Third page text."),
    ]);
    expect(text).not.toMatch(/Acme Quarterly Report|Page \d of 3/);
    expect(text).toContain("The company grew quickly.\n\nA new paragraph.");
  });

  it("rejoins a compound that was broken at its own hyphen", () => {
    expect(normalizePages([{ page: 1, text: "measures against Al-\nQaida organisations and their sup-\nporters in the region." }]).text).toBe(
      "measures against Al-Qaida organisations and their supporters in the region.",
    );
  });

  it("keeps a heading apart from the sentence under it", () => {
    const { text } = normalizePages([{ page: 1, text: "Item 10\nThe Meridian Open, a chess tournament, was held in Tbilisi in August 2022 and drew\nplayers from many countries." }]);
    expect(text).toBe("Item 10\n\nThe Meridian Open, a chess tournament, was held in Tbilisi in August 2022 and drew players from many countries.");
    expect(splitSentences(text).map((s) => text.slice(s.start, s.end))[1]).toMatch(/^The Meridian Open/);
  });

  it("maps offsets to pages and lets a sentence run across a page break", () => {
    const { text, pageMap } = normalizePages([
      { page: 1, text: "Helena Marquez founded" },
      { page: 2, text: "Nordlight Robotics in 2014." },
    ]);
    expect(text).toBe("Helena Marquez founded Nordlight Robotics in 2014.");
    expect(pageAt(pageMap, text.indexOf("Helena"))).toBe(1);
    expect(pageAt(pageMap, text.indexOf("Nordlight"))).toBe(2);
    expect(splitSentences(text)).toHaveLength(1);
  });
});

describe("segment", () => {
  const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} mentions Oslo and Lisbon today.`).join(" ");
  const doc = documentFromText(text, "t");

  it("asks about every askable token in exactly one chunk and respects the chunk size", () => {
    const { tokens, chunks } = segment(doc, 20);
    const seen = new Map<number, number>();
    for (const chunk of chunks) {
      const asked = tokens.slice(chunk.tokenStart, chunk.tokenEnd).filter(isAskable);
      expect(asked.length).toBeLessThanOrEqual(20);
      for (const token of asked) seen.set(token.index, (seen.get(token.index) ?? 0) + 1);
      expect(doc.text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(tokens.filter(isAskable).length);
  });

  it("gives each chunk after the first the previous sentence as context", () => {
    const { chunks } = segment(doc, 20);
    expect(chunks[0]!.contextBefore).toBe("");
    expect(chunks[1]!.contextBefore).toMatch(/^Sentence number \d+ mentions/);
  });

  it("cuts a sentence that is longer than a chunk", () => {
    const long = documentFromText(Array.from({ length: 50 }, (_, i) => `word${i}`).join(" "), "long");
    const { tokens, chunks } = segment(long, 20);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(tokens.slice(chunk.tokenStart, chunk.tokenEnd).filter(isAskable).length).toBeLessThanOrEqual(20);
  });
});
