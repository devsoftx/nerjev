import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCalls } from "../src/bench/recorder.js";
import { createTypeSafe } from "../src/clients.js";
import { scoreAgainstGold } from "../src/eval/gold.js";
import { documentFromText } from "../src/pdf/extract.js";
import { DEFAULT_OPTIONS, type PipelineOptions, runPipeline } from "../src/pipeline.js";
import { loadSchema } from "../src/schema.js";
import { fakeJev, type Lexicon } from "./helpers/fakeJev.js";

const TEXT = "Helena Marquez founded Nordlight Robotics in 2014. Marquez still leads Nordlight Robotics, which is headquartered in Oslo.";

const lexicon: Lexicon = {
  words: { Helena: "person", Marquez: "person", Nordlight: "organization", Robotics: "organization", "2014": "date", Oslo: "location" },
  phrases: { "Helena Marquez": "person", Marquez: "person", "Nordlight Robotics": "organization", "2014": "date", Oslo: "location" },
  relations: {
    "Helena Marquez|Nordlight Robotics": "A_founded_B",
    "Marquez|Nordlight Robotics": "A_works_for_B",
    "Nordlight Robotics|Oslo": "A_located_in_B",
  },
};

const temp: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "nerjev-"));
  temp.push(dir);
  return dir;
};
afterEach(() => temp.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const options = (overrides: Partial<PipelineOptions> = {}): PipelineOptions => ({
  ...DEFAULT_OPTIONS,
  schema: loadSchema(),
  schemaPath: "schema/default.schema.json",
  model: "jev-test",
  cacheDir: null,
  outDir: null,
  log: () => {},
  ...overrides,
});

describe("runPipeline with a fake Jev", () => {
  it("goes from text to entities and relations, resolving the short name to the full one", async () => {
    const result = await runPipeline(documentFromText(TEXT, "t"), createTypeSafe(fakeJev(lexicon)), options());

    expect(result.mentions.map((m) => `${m.text}|${m.type}`)).toEqual([
      "Helena Marquez|person", "Nordlight Robotics|organization", "2014|date", "Marquez|person", "Nordlight Robotics|organization", "Oslo|location",
    ]);
    for (const mention of result.mentions) expect(result.doc.text.slice(mention.start, mention.end)).toBe(mention.text);

    const helena = result.entities.find((e) => e.type === "person")!;
    expect(helena).toMatchObject({ canonicalName: "Helena Marquez", aliases: ["Marquez"] });
    expect(result.alignment).toHaveLength(1);

    const named = result.relations.map((r) => {
      const name = (id: string) => result.entities.find((e) => e.id === id)!.canonicalName;
      return `${name(r.sourceId)} ${r.type} ${name(r.targetId)}`;
    });
    expect(named.sort()).toEqual(["Helena Marquez founded Nordlight Robotics", "Helena Marquez works_for Nordlight Robotics", "Nordlight Robotics located_in Oslo"]);
    expect(result.relations.every((r) => r.evidence[0]!.sentence.length > 0 && !r.needsReview)).toBe(true);
  });

  it("scores perfectly against a matching gold passage", async () => {
    const result = await runPipeline(documentFromText(TEXT, "t"), createTypeSafe(fakeJev(lexicon)), options());
    const score = scoreAgainstGold(
      {
        id: "t",
        text: TEXT,
        entities: Object.entries(lexicon.phrases).map(([text, type]) => ({ text, type })),
        relations: [
          { source: "Helena Marquez", type: "founded", target: "Nordlight Robotics" },
          { source: "Marquez", type: "works_for", target: "Nordlight Robotics" },
          { source: "Nordlight Robotics", type: "located_in", target: "Oslo" },
        ],
      },
      result,
    );
    expect(score.errors).toEqual([]);
    expect(score.entity.f1).toBe(1);
    expect(score.relation.f1).toBe(1);
  });

  it("records one row per API call with tokens, bytes, latency and the reported model", async () => {
    const outDir = tempDir();
    const result = await runPipeline(documentFromText(TEXT, "t"), createTypeSafe(fakeJev(lexicon)), options({ outDir }));
    const rows = readCalls(join(result.runDir!, "calls.jsonl"));
    expect(rows.map((r) => r.stage)).toEqual(["ner_tag", "ner_resolve", "ner_type", "entity_align", "relation"]);
    for (const row of rows) {
      expect(row).toMatchObject({ provider: "typesafe", model: "jev-test", attempts: 1, statusCodes: [200], cached: false, error: null });
      expect(row.requestBytes).toBeGreaterThan(0);
      expect(row.responseBytes).toBeGreaterThan(0);
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.latencyMs).not.toBeNull();
      expect(row.requestId).toMatch(/^req_/);
    }
    // 7 askable words in the first sentence and 10 in the second
    expect(rows[0]!.questionCount).toBe(17);
    const manifest = JSON.parse(readFileSync(join(result.runDir!, "manifest.json"), "utf8"));
    expect(manifest.counts).toMatchObject({ entities: 4, relations: 3, calls: 5 });
  });

  it("counts a retried call once, with every attempt's status", async () => {
    const log = { requests: 0, failFirst: 1 };
    const outDir = tempDir();
    const client = createTypeSafe(fakeJev(lexicon, log));
    const result = await runPipeline(documentFromText("Oslo grew.", "t"), client, options({ outDir }));
    const first = result.calls[0]!;
    expect(first.attempts).toBe(2);
    expect(first.statusCodes).toEqual([529, 200]);
    expect(first.wallMs).toBeGreaterThan(first.latencyMs!);
  }, 20_000);

  it("serves a repeat run from the cache without touching the network", async () => {
    const cacheDir = tempDir();
    const log = { requests: 0 };
    const client = createTypeSafe(fakeJev(lexicon, log));
    const first = await runPipeline(documentFromText(TEXT, "t"), client, options({ cacheDir }));
    const after = log.requests;
    const second = await runPipeline(documentFromText(TEXT, "t"), client, options({ cacheDir }));
    expect(log.requests).toBe(after);
    expect(second.calls.every((c) => c.cached)).toBe(true);
    expect(second.entities).toEqual(first.entities);
  });

  it("skips span resolution with resolve: false", async () => {
    const result = await runPipeline(documentFromText(TEXT, "t"), createTypeSafe(fakeJev(lexicon)), options({ resolve: false }));
    expect(result.calls.some((c) => c.stage === "ner_resolve" || c.stage === "ner_type")).toBe(false);
    expect(result.mentions.map((m) => m.text)).toContain("Nordlight Robotics");
  });
});
