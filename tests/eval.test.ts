import { describe, expect, it } from "vitest";
import { costOf, loadPricing } from "../src/bench/pricing.js";
import { buildReport, callStats, quantile } from "../src/bench/report.js";
import { interpret } from "../src/eval/evaluate.js";
import { loadGold } from "../src/eval/gold.js";
import { calibration, entityMetrics, type MentionVerdict, prf, relationMetrics, type RelationVerdict, strictCorrect, verdictAgreement } from "../src/eval/metrics.js";
import { loadSchema } from "../src/schema.js";
import type { CallRecord, Chunk, Mention } from "../src/types.js";

const schema = loadSchema();
const pricing = loadPricing();

const verdict = (id: string, flags: Partial<MentionVerdict>): MentionVerdict => ({
  mentionId: id, chunkId: "c0000", confidence: 0.9, accepted: true, isEntity: true, boundaryExact: true, typeCorrect: true, ...flags,
});

describe("metrics", () => {
  it("computes precision, recall and F1, with null where a ratio is undefined", () => {
    expect(prf(8, 2, 2)).toMatchObject({ precision: 0.8, recall: 0.8 });
    expect(prf(8, 2, 2).f1).toBeCloseTo(0.8);
    expect(prf(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null });
  });

  it("counts a real entity with a wrong boundary as both a false positive and a miss", () => {
    const verdicts = [verdict("a", {}), verdict("b", { boundaryExact: false }), verdict("c", { isEntity: false, boundaryExact: false, typeCorrect: false })];
    expect(entityMetrics(verdicts, 1, strictCorrect)).toMatchObject({ tp: 1, fp: 2, fn: 2 });
  });

  it("counts a real entity held back for review as a miss and not as a false positive", () => {
    expect(entityMetrics([verdict("a", { accepted: false })], 0, strictCorrect)).toMatchObject({ tp: 0, fp: 0, fn: 1 });
  });

  it("treats a relation as correct when any chunk of evidence supports it", () => {
    const rel = (chunkId: string, supported: boolean): RelationVerdict => ({
      relationId: "r", chunkId, confidence: 0.9, accepted: true, supported, typeCorrect: supported, directionCorrect: supported,
    });
    expect(relationMetrics([rel("c1", false), rel("c2", true)], 0)).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(relationMetrics([rel("c1", false)], 2)).toMatchObject({ tp: 0, fp: 1, fn: 2 });
  });

  it("measures calibration error as the weighted gap between confidence and accuracy", () => {
    const perfect = calibration([...Array(9).fill({ confidence: 0.9, correct: true }), { confidence: 0.9, correct: false }]);
    expect(perfect.ece).toBeCloseTo(0, 5);
    const overconfident = calibration(Array(10).fill({ confidence: 0.95, correct: false }));
    expect(overconfident.ece).toBeCloseTo(0.95, 5);
    expect(calibration([]).ece).toBeNull();
  });

  it("measures how often two judge passes agree", () => {
    expect(verdictAgreement({ a: [true, true, false], b: [true, false, false] }, { a: [true, true, true], b: [true, false, false] })).toEqual({ agreement: 5 / 6, compared: 6 });
  });
});

describe("interpret", () => {
  const text = "Tim Cook leads Apple. Cook met Satya Nadella in Seattle.";
  const chunk: Chunk = { id: "c0000", index: 0, start: 100, end: 100 + text.length, text, contextBefore: "", sentenceStart: 0, sentenceEnd: 2, tokenStart: 0, tokenEnd: 12 };
  const at = (phrase: string) => 100 + text.indexOf(phrase);
  const mention = (id: string, phrase: string, type: string): Mention => ({
    id, chunkId: "c0000", sentence: 0, text: phrase, start: at(phrase), end: at(phrase) + phrase.length, page: 1, type, confidence: 0.9, boundaryP: 0.9, typeP: 1, status: "accepted",
  });
  const mentions = [mention("x1", "Tim Cook", "person"), mention("x2", "Apple", "organization")];
  const input = { chunk, mentions, relations: [], judgedMentions: [{ id: "m1", text: "Tim Cook", type: "person" }, { id: "m2", text: "Apple", type: "organization" }], judgedRelations: [] };
  const allTrue = (id: string) => ({ id, is_entity: true, boundary_exact: true, type_correct: true, note: "" });

  it("keeps a miss only when it is quoted verbatim, has a schema type and was not already extracted", () => {
    const judgement = interpret(
      input,
      {
        mentions: [allTrue("m1"), allTrue("m2")],
        relations: [],
        missed_entities: [
          { quote: "Satya Nadella", type: "person" }, // valid
          { quote: "Seattle", type: "location" }, // valid
          { quote: "Microsoft", type: "organization" }, // not in the passage: invented
          { quote: "Tim Cook", type: "organization" }, // overlaps an extracted mention
          { quote: "Cook", type: "person" }, // the second "Cook" is free, so this one stands
          { quote: "Seattle", type: "planet" }, // not a schema type
        ],
        missed_relations: [{ source_quote: "Satya Nadella", relation: "works_for", target_quote: "Microsoft" }],
      },
      schema,
    );
    expect(judgement.missedEntities.map((m) => m.quote)).toEqual(["Satya Nadella", "Seattle", "Cook"]);
    expect(judgement.missedRelations).toEqual([]);
    expect(judgement.discardedMisses).toBe(4);
  });

  it("forces dependent verdicts to false and counts verdicts the judge left out", () => {
    const judgement = interpret(input, { mentions: [{ id: "m1", is_entity: false, boundary_exact: true, type_correct: true, note: "" }], relations: [], missed_entities: [], missed_relations: [] }, schema);
    expect(judgement.mentionVerdicts).toEqual([expect.objectContaining({ mentionId: "x1", isEntity: false, boundaryExact: false, typeCorrect: false })]);
    expect(judgement.missingVerdicts).toBe(1);
  });
});

describe("pricing and report", () => {
  const call = (overrides: Partial<CallRecord>): CallRecord => ({
    runId: "r", variant: "v", docId: "d", chunkId: "c0000", stage: "ner_tag", provider: "typesafe", model: "jev-1.13.0", requestId: "q", startedAt: "2026-09-19T00:00:00Z",
    latencyMs: 100, wallMs: 110, attempts: 1, statusCodes: [200], requestBytes: 4000, responseBytes: 1000, inputTokens: 1_000_000, outputTokens: 500,
    cacheReadTokens: null, cacheWriteTokens: null, questionCount: 40, stateChars: 300, cached: false, error: null, ...overrides,
  });

  it("prices a call from its recorded tokens and the model the response reported", () => {
    expect(costOf(pricing, call({}))).toBeCloseTo(0.042, 6);
    expect(costOf(pricing, call({ model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeCloseTo(30, 6);
    expect(costOf(pricing, call({ model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.5, 6);
    expect(costOf(pricing, call({ model: "claude-opus-5-20270101" }))).not.toBeNull();
  });

  it("returns null for a model with no price, and nothing for a cached call", () => {
    expect(costOf(pricing, call({ model: "mystery-1" }))).toBeNull();
    expect(costOf(pricing, call({ cached: true }))).toBe(0);
    expect(callStats([call({ model: "mystery-1" })], pricing).cost).toBeNull();
  });

  it("leaves cached calls out of every statistic", () => {
    const stats = callStats([call({ latencyMs: 100 }), call({ latencyMs: 300, attempts: 2, statusCodes: [429, 200] }), call({ cached: true, latencyMs: null })], pricing);
    expect(stats).toMatchObject({ calls: 2, inputTokens: 2_000_000, latencyP50: 200, retried: 1, rateLimited: 1, requestBytes: 8000 });
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("reports pipeline cost and judge cost on separate lines", () => {
    const manifest = { runId: "r", docId: "d", variant: "v", model: "jev-1.13.0", schemaPath: "s", options: {}, startedAt: "", wallMs: 2000, counts: { pages: 2, entities: 10, graphRelations: 5, relations: 5, mentions: 12 } };
    const { markdown, csv } = buildReport({
      pricing,
      runs: [{ manifest, calls: [call({}), call({ stage: "judge", provider: "anthropic", model: "claude-opus-5", inputTokens: 2000, outputTokens: 1000 })] }],
      gold: {},
      goldPassages: 0,
    });
    expect(markdown).toContain("| v | d | 1 | 1.0 | 1,000,000 |");
    expect(markdown).toContain("$0.0350"); // judge: 2000 * 5/M + 1000 * 25/M
    expect(csv.split("\n")[1]).toContain("0.042");
  });
});

describe("gold set", () => {
  it("loads, and every label is verbatim text with a schema type", () => {
    const gold = loadGold("bench/gold", schema);
    expect(gold.length).toBeGreaterThanOrEqual(12);
    expect(gold.some((p) => p.entities.length === 0)).toBe(true);
  });
});
