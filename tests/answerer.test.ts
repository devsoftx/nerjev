import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAnswerer, PROTOCOL_PROMPT, toJevAnswers } from "../src/answerer.js";
import { createAnthropic } from "../src/clients.js";
import { documentFromText } from "../src/pdf/extract.js";
import { DEFAULT_OPTIONS, runPipeline } from "../src/pipeline.js";
import { loadSchema } from "../src/schema.js";
import { fakeClaude, fakeJev, type Lexicon } from "./helpers/fakeJev.js";
import { createTypeSafe } from "../src/clients.js";

const questions = {
  kind: choice("Which kind?", { person: null, location: null, none: "not an entity" }),
  edge: choice("Which phrase?", { "Bank of America": null, Bank: null, none: "not a mention" }),
  same: score("Same entity?", ["different", "unsure", "same"]),
  yes: noul("Is it urgent?"),
};

describe("toJevAnswers", () => {
  it("spreads a hard answer and its stated confidence into the distribution the pipeline reads", () => {
    const { answers, missing, invalid } = toJevAnswers(questions, [
      { id: "kind", answer: "person", confidence: 0.8 },
      { id: "edge", answer: "Bank of America", confidence: 1 },
      { id: "same", answer: "2", confidence: 0.9 },
      { id: "yes", answer: "yes", confidence: 0.7 },
    ]);
    expect([missing, invalid]).toEqual([0, 0]);
    const kind = answers.kind as { choice: string; probabilities: Record<string, number> };
    expect(kind.choice).toBe("person");
    expect(kind.probabilities.person).toBeCloseTo(0.8);
    expect(kind.probabilities.none).toBeCloseTo(0.1);
    expect(Object.values(kind.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(answers.same).toMatchObject({ type: "score", score: 2 });
    expect(answers.yes).toMatchObject({ type: "noul", noul: 0.7 });
  });

  it("turns a skipped question or an option that was never offered into a certain 'none'", () => {
    const { answers, missing, invalid } = toJevAnswers(questions, [
      { id: "edge", answer: "Bank of Amerika", confidence: 0.99 }, // a generated string, not one of the options
      { id: "same", answer: "7", confidence: 0.9 },
      { id: "yes", answer: "no", confidence: 0.8 },
    ]);
    expect([missing, invalid]).toEqual([1, 2]);
    expect(answers.kind).toMatchObject({ choice: "none", confidence: 0, probabilities: { none: 1, person: 0 } });
    expect(answers.edge).toMatchObject({ choice: "none", probabilities: { none: 1 } });
    expect(answers.same).toMatchObject({ score: 0 });
    expect((answers.yes as { noul: number }).noul).toBeCloseTo(0.2);
  });

  it("describes the protocol and says nothing about entities", () => {
    expect(PROTOCOL_PROMPT).toMatch(/copied character for character/);
    expect(PROTOCOL_PROMPT).not.toMatch(/entity|person|organization/i);
  });
});

describe("the same pipeline answered by Claude", () => {
  const TEXT = "Helena Marquez founded Nordlight Robotics in 2014. Marquez still leads Nordlight Robotics, which is headquartered in Oslo.";
  const lexicon: Lexicon = {
    words: { Helena: "person", Marquez: "person", Nordlight: "organization", Robotics: "organization", "2014": "date", Oslo: "location" },
    phrases: { "Helena Marquez": "person", Marquez: "person", "Nordlight Robotics": "organization", "2014": "date", Oslo: "location" },
    relations: { "Helena Marquez|Nordlight Robotics": "A_founded_B", "Marquez|Nordlight Robotics": "A_works_for_B", "Nordlight Robotics|Oslo": "A_located_in_B" },
  };
  const options = { ...DEFAULT_OPTIONS, schema: loadSchema(), schemaPath: "schema", cacheDir: null, outDir: null, log: () => {} };
  const names = (r: Awaited<ReturnType<typeof runPipeline>>) => r.entities.map((e) => `${e.type}:${e.canonicalName}`).sort();

  it("sends Claude the request Jev gets and reaches the same entities and relations", async () => {
    const sent: string[] = [];
    const spy = fakeClaude(lexicon);
    const claude = new ClaudeAnswerer(createAnthropic(async (input, init) => {
      sent.push(JSON.parse(String(init?.body)).messages[0].content);
      return spy(input, init);
    }), "low");
    const viaClaude = await runPipeline(documentFromText(TEXT, "t"), claude, { ...options, model: "claude-opus-5" });
    const viaJev = await runPipeline(documentFromText(TEXT, "t"), createTypeSafe(fakeJev(lexicon)), { ...options, model: "jev-test" });

    expect(names(viaClaude)).toEqual(names(viaJev));
    expect(viaClaude.relations.map((r) => r.type).sort()).toEqual(viaJev.relations.map((r) => r.type).sort());
    // the user message is exactly {state, questions}: the stages and ids are the pipeline's own
    const first = JSON.parse(sent[0]!) as { state: { text: string; kinds: object }; questions: Record<string, { type: string }> };
    expect(Object.keys(first)).toEqual(["state", "questions"]);
    expect(first.state.text).toBe(TEXT);
    expect(first.questions.t0).toMatchObject({ type: "choice" });

    expect(viaClaude.calls.map((c) => c.stage)).toEqual(["ner_tag", "ner_resolve", "ner_type", "entity_align", "relation"]);
    for (const call of viaClaude.calls) expect(call).toMatchObject({ provider: "anthropic", model: "claude-opus-5", error: null });
    expect(viaClaude.manifest.counts).toMatchObject({ missingAnswers: 0, invalidAnswers: 0 });
  });

  it("drops a boundary the model re-typed wrongly instead of trusting generated text", async () => {
    const claude = new ClaudeAnswerer(createAnthropic(fakeClaude(lexicon, { mangle: (id, answer) => (id === "b0" ? "Helena Marqués" : answer) })), "low");
    const result = await runPipeline(documentFromText(TEXT, "t"), claude, { ...options, model: "claude-opus-5" });
    expect(result.mentions.map((m) => m.text)).not.toContain("Helena Marquez");
    for (const mention of result.mentions) expect(result.doc.text.slice(mention.start, mention.end)).toBe(mention.text);
    expect(result.manifest.counts).toMatchObject({ invalidAnswers: 1 });
  });
});
