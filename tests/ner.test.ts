import { describe, expect, it } from "vitest";
import { assembleSpans } from "../src/ner/assemble.js";
import { boundaryCandidates, buildBoundaryQuestions, dropOverlaps } from "../src/ner/resolve.js";
import { buildTagQuestions, decideTag, leanState, markInContext, NONE } from "../src/ner/tag.js";
import { documentFromText } from "../src/pdf/extract.js";
import { loadSchema } from "../src/schema.js";
import { segment } from "../src/text/chunk.js";
import { isAskable } from "../src/text/tokenize.js";
import type { TokenTag } from "../src/types.js";

const schema = loadSchema();

/** Segments `text` and tags the listed words, as the tagger would have. */
function setup(text: string, tagged: Record<string, string>) {
  const doc = documentFromText(text, "t");
  const { tokens, chunks } = segment(doc, 80);
  const tags: TokenTag[] = tokens.filter(isAskable).map((token) => {
    const type = tagged[token.text];
    const probabilities = type ? { [type]: 0.9, [NONE]: 0.1 } : { [NONE]: 1 };
    return decideTag(token.index, probabilities, 0.5);
  });
  return { doc, tokens, chunk: chunks[0]!, tags };
}

describe("tag questions", () => {
  it("asks once per askable token and marks the word among its neighbours", () => {
    const { doc, tokens, chunk } = setup("Tim Cook said Apple's team grew.", {});
    const questions = buildTagQuestions(doc.text, tokens, chunk, schema);
    expect(Object.keys(questions)).toHaveLength(tokens.filter(isAskable).length);
    const apple = tokens.find((t) => t.text === "Apple")!;
    expect(markInContext(doc.text, tokens, chunk, apple.index, apple.index)).toBe("Tim Cook said [[Apple]]'s team grew.");
    expect(Object.keys(questions.t0!.criteria)).toEqual([...Object.keys(schema.entities), NONE]);
  });

  it("decides entity-ness from P(none) and the type from the best other option", () => {
    expect(decideTag(0, { person: 0.3, organization: 0.35, none: 0.35 }, 0.5).type).toBe("organization");
    expect(decideTag(0, { person: 0.3, none: 0.7 }, 0.5).type).toBeNull();
  });
});

describe("assembleSpans", () => {
  const spansOf = (text: string, tagged: Record<string, string>) => {
    const { doc, tokens, chunk, tags } = setup(text, tagged);
    return assembleSpans(doc.text, tokens, chunk, tags).map((s) => `${s.text}|${s.type}`);
  };

  it("merges adjacent tokens of one type and splits on a type change", () => {
    expect(spansOf("Tim Cook leads Apple Inc. today.", { Tim: "person", Cook: "person", Apple: "organization", "Inc.": "organization" })).toEqual([
      "Tim Cook|person",
      "Apple Inc.|organization",
    ]);
  });

  it("bridges a tight hyphen and an ampersand, but not a comma", () => {
    const org = { Hewlett: "organization", Packard: "organization", Procter: "organization", Gamble: "organization" };
    expect(spansOf("Hewlett-Packard and Procter & Gamble met.", org)).toEqual(["Hewlett-Packard|organization", "Procter & Gamble|organization"]);
    expect(spansOf("She lives in Austin, Texas now.", { Austin: "location", Texas: "location" })).toEqual(["Austin|location", "Texas|location"]);
  });

  it("keeps a bracketed part inside a name, and never ends a span on a function word", () => {
    const doc = { Regulation: "document", EU: "document", "2016/44": "document", of: "document", a: "document" };
    expect(spansOf("It amends Regulation (EU) 2016/44 of the Council.", doc)).toEqual(["Regulation (EU) 2016/44|document"]);
    expect(spansOf("See Regulation (EU) 2016/44 a) and b).", doc)).toEqual(["Regulation (EU) 2016/44|document"]);
    // a span that opens a bracket closes it, and so does every boundary candidate built from it
    expect(spansOf("Shares of Apple (AAPL) rose.", { Apple: "organization", AAPL: "organization" })).toEqual(["Apple (AAPL)|organization"]);
    const isil = setup("It lists ISIL (Da'esh) and others.", { ISIL: "organization", "Da'esh": "organization" });
    const spans = assembleSpans(isil.doc.text, isil.tokens, isil.chunk, isil.tags);
    const offered = boundaryCandidates(spans[0]!, spans, isil.tokens, isil.chunk, isil.doc.text).map((c) => c.text);
    expect(offered).toContain("ISIL (Da'esh)");
    expect(offered).not.toContain("ISIL (Da'esh");
    expect(offered).toContain("ISIL");
  });

  it("does not join across a slash, which separates alternatives", () => {
    expect(spansOf("Sanctions target Al-Qaida/ISIL networks.", { Al: "organization", Qaida: "organization", ISIL: "organization" })).toEqual([
      "Al-Qaida|organization",
      "ISIL|organization",
    ]);
  });

  it("never starts a span with a lowercase preposition or conjunction", () => {
    const org = { of: "organization", the: "organization", Council: "organization", European: "organization", Union: "organization" };
    expect(spansOf("Regulations of the Council of the European Union apply.", org)).toEqual(["Council of the European Union|organization"]);
  });

  it("never joins across a sentence boundary", () => {
    expect(spansOf("He visited Paris. London was next.", { Paris: "location", London: "location" })).toEqual(["Paris|location", "London|location"]);
  });

  it("drops a leading article, including a capitalized one that opens the sentence", () => {
    const event = { the: "event", The: "event", Meridian: "event", Open: "event" };
    expect(spansOf("The Meridian Open began.", event)).toEqual(["Meridian Open|event"]);
    expect(spansOf("They won the Meridian Open.", event)).toEqual(["Meridian Open|event"]);
  });
});

describe("boundaryCandidates", () => {
  it("offers only verbatim phrases: the span, grown, shrunk and joined with a neighbour", () => {
    const { doc, tokens, chunk, tags } = setup("She joined the Bank of America in Boston.", { Bank: "organization", America: "location" });
    const spans = assembleSpans(doc.text, tokens, chunk, tags);
    const bank = spans.find((s) => s.text === "Bank")!;
    const texts = boundaryCandidates(bank, spans, tokens, chunk, doc.text).map((c) => c.text);
    expect(texts[0]).toBe("Bank");
    expect(texts).toContain("Bank of America");
    for (const candidate of boundaryCandidates(bank, spans, tokens, chunk, doc.text)) {
      expect(doc.text.slice(candidate.start, candidate.end)).toBe(candidate.text);
    }
    // "the" is pulled in from the edge, so no candidate starts with the article
    expect(texts.some((t) => t.startsWith("the "))).toBe(false);
  });

  it("can drop two trailing generic words, and never opens with a possessive", () => {
    const product = { Fjord: "product", X1: "product", warehouse: "product", robot: "product" };
    const a = setup("It makes the Fjord X1 warehouse robot.", product);
    const spans = assembleSpans(a.doc.text, a.tokens, a.chunk, a.tags);
    expect(boundaryCandidates(spans[0]!, spans, a.tokens, a.chunk, a.doc.text).map((c) => c.text)).toContain("Fjord X1");

    const officer = { its: "officer", chief: "officer", technology: "officer", officer: "officer" };
    const b = setup("Tanaka serves as its chief technology officer.", officer);
    expect(assembleSpans(b.doc.text, b.tokens, b.chunk, b.tags).map((s) => s.text)).toEqual(["chief technology officer"]);
  });

  it("stays inside the sentence", () => {
    const { doc, tokens, chunk, tags } = setup("He met Cook. Apple grew.", { Cook: "person", Apple: "organization" });
    const spans = assembleSpans(doc.text, tokens, chunk, tags);
    const texts = boundaryCandidates(spans[0]!, spans, tokens, chunk, doc.text).map((c) => c.text);
    expect(texts.some((t) => t.includes("Apple"))).toBe(false);
  });

  it("still offers a clause-length span as itself, and asks nothing when no option survives", () => {
    const words = Array.from({ length: 16 }, (_, i) => `word${i}`);
    const long = setup(`The report finds that ${words.join(" ")} today.`, Object.fromEntries(words.map((w) => [w, "finding"])));
    const longSpans = assembleSpans(long.doc.text, long.tokens, long.chunk, long.tags);
    const offered = boundaryCandidates(longSpans[0]!, longSpans, long.tokens, long.chunk, long.doc.text);
    // the 16-word span is offered as itself despite the 12-word cap, which still applies to its variants
    expect(offered[0]!.text).toBe(words.join(" "));
    for (const variant of offered.slice(1)) expect(variant.text.split(" ").length).toBeLessThanOrEqual(12);

    const huge = Array.from({ length: 45 }, (_, i) => `w${i}`);
    const tooLong = setup(`It finds ${huge.join(" ")} now.`, Object.fromEntries(huge.map((w) => [w, "finding"])));
    const spans = assembleSpans(tooLong.doc.text, tooLong.tokens, tooLong.chunk, tooLong.tags);
    expect(buildBoundaryQuestions(tooLong.doc.text, tooLong.tokens, tooLong.chunk, spans, schema).questions).toEqual({});
  });

  it("in lean mode sends bare labels and leaves the definitions to the state", () => {
    const { doc, tokens, chunk, tags } = setup("It opened in Oslo.", { Oslo: "location" });
    const lean = buildTagQuestions(doc.text, tokens, chunk, schema, true);
    expect(Object.values(lean.t0!.criteria).filter((d) => d !== null)).toHaveLength(1); // only `none` keeps its text
    expect(leanState(chunk, schema, true)).toMatchObject({ kinds: schema.entities, text: "It opened in Oslo." });
    expect(leanState(chunk, schema, false)).not.toHaveProperty("kinds");
    const boundary = buildBoundaryQuestions(doc.text, tokens, chunk, assembleSpans(doc.text, tokens, chunk, tags), schema, true);
    expect(boundary.questions.b0!.instructions).not.toHaveProperty("kinds");
  });

  it("lists the schema's kinds in the question so a date counts as a mention", () => {
    const { doc, tokens, chunk, tags } = setup("It opened in 2014.", { "2014": "date" });
    const { questions } = buildBoundaryQuestions(doc.text, tokens, chunk, assembleSpans(doc.text, tokens, chunk, tags), schema);
    const instructions = questions.b0!.instructions as { kinds: Record<string, string> };
    expect(Object.keys(instructions.kinds)).toContain("date");
    expect(Object.keys(questions.b0!.criteria)).toContain(NONE);
  });
});

describe("dropOverlaps", () => {
  const item = (start: number, end: number, confidence: number) => ({ start, end, confidence });

  it("prefers the longer of two accepted overlapping spans", () => {
    expect(dropOverlaps([item(7, 20, 0.99), item(0, 20, 0.8)], 0.7)).toEqual([item(0, 20, 0.8)]);
  });

  it("prefers an accepted span over a longer review-band one", () => {
    expect(dropOverlaps([item(7, 20, 0.9), item(0, 20, 0.5)], 0.7)).toEqual([item(7, 20, 0.9)]);
  });

  it("keeps spans that do not overlap, in document order", () => {
    expect(dropOverlaps([item(10, 15, 0.9), item(0, 5, 0.8)], 0.7)).toEqual([item(0, 5, 0.8), item(10, 15, 0.9)]);
  });
});
