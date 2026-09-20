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

/** Jev-shaped answers from the lexicon, for any set of questions the pipeline builds. */
export function decide(questions: Record<string, FakeQuestion>, lexicon: Lexicon): Record<string, any> {
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
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
    return answers;
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
    const answers = decide(body.questions, lexicon);
    const inputTokens = Math.ceil(String(init?.body).length / 4);
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: inputTokens, output_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": `req_${log.requests}` },
    });
  };
}

/**
 * A stand-in for POST /v1/messages. It reads the {state, questions} JSON the ClaudeAnswerer sends as
 * the user message and replies with the structured output a model would: an answer and a confidence
 * per question id. `mangle` lets a test return an option the question never offered.
 */
export function fakeClaude(lexicon: Lexicon, options: { mangle?: (id: string, answer: string) => string; skip?: string[] } = {}): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    const request = JSON.parse(body.messages[0]!.content) as { questions: Record<string, FakeQuestion> };
    const decided = decide(request.questions, lexicon);
    const answers = Object.entries(decided)
      .filter(([id]) => !options.skip?.includes(id))
      .map(([id, a]) => {
        const answer = a.type === "score" ? String(a.score) : String(a.choice);
        return { id, answer: options.mangle ? options.mangle(id, answer) : answer, confidence: 0.9 };
      });
    const message = {
      id: "msg_fake", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ answers }) }],
      usage: { input_tokens: Math.ceil(String(init?.body).length / 4), output_tokens: answers.length * 12 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fake" } });
  };
}
