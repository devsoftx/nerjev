import type { FetchLike } from "../../src/telemetry/instrumentedFetch.js";

interface FakeQuestion {
  type: "choice" | "noul" | "score";
  instructions: Record<string, unknown>;
  criteria: Record<string, unknown> | unknown[];
}

export interface Lexicon {
  /** Word -> entity type, as the tagger should answer. */
  words: Record<string, string>;
  /** Full phrase -> entity type, for the boundary and type questions. */
  phrases: Record<string, string>;
  /** "A text|B text" -> option label, for relation questions. */
  relations: Record<string, string>;
}

/**
 * A stand-in for POST /v1/systemone that answers from a lexicon. It is reached through the SDK's
 * `fetch` option, so the real client, retry logic and telemetry all run; only the network is fake.
 */
export function fakeJev(lexicon: Lexicon, log: { requests: number; failFirst?: number } = { requests: 0 }): FetchLike {
  return async (_input, init) => {
    log.requests++;
    if (log.failFirst && log.requests <= log.failFirst) return new Response(JSON.stringify({ error: "overloaded" }), { status: 529 });
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, FakeQuestion> };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "score") {
        answers[id] = { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: { "0": 0, "1": 0.05, "2": 0.95 } };
        continue;
      }
      const options = Object.keys(question.criteria);
      const pick = (label: string, p = 0.96) => {
        const rest = (1 - p) / Math.max(1, options.length - 1);
        answers[id] = { type: "choice", choice: label, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === label ? p : rest])) };
      };
      const { word, phrase, A, B } = question.instructions as Record<string, string | undefined>;
      if (word !== undefined) pick(lexicon.words[word] ?? "none");
      else if (A !== undefined && B !== undefined) pick(lexicon.relations[`${A.replace(/ \(.*/, "")}|${B.replace(/ \(.*/, "")}`] ?? "none");
      else if (phrase !== undefined) pick(lexicon.phrases[phrase] ?? "not_an_entity");
      // a boundary question: prefer the longest option that is a known phrase
      else pick(options.filter((o) => o in lexicon.phrases).sort((a, b) => b.length - a.length)[0] ?? "none");
    }
    const inputTokens = Math.ceil(String(init?.body).length / 4);
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: inputTokens, output_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": `req_${log.requests}` },
    });
  };
}
