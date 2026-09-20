import { choice, type ChoiceQuestion, type EntryType } from "@typesafe-ai/sdk";
import type { Jev } from "../jev/client.js";
import type { ExtractionSchema } from "../schema.js";
import { isAskable } from "../text/tokenize.js";
import type { Chunk, Token, TokenTag } from "../types.js";

export const NONE = "none";
const CONTEXT_WINDOW_TOKENS = 8;

/** The chunk as Jev sees it. The previous sentence rides along for disambiguation and nothing else does. */
export function chunkState(chunk: Chunk, kinds?: Record<string, string>): EntryType {
  return { ...(kinds ? { kinds } : {}), ...(chunk.contextBefore ? { context_before: chunk.contextBefore } : {}), text: chunk.text };
}

/** Lean mode: the definitions travel once in `state.kinds`, so the options are bare labels. */
export const leanState = (chunk: Chunk, schema: ExtractionSchema, lean: boolean) => chunkState(chunk, lean ? schema.entities : undefined);

/**
 * Quotes tokens from..to (inclusive) with their neighbours and wraps them in [[ ]]. Quoting the words
 * avoids an index lookup into state, and the neighbours tell apart a word that occurs twice.
 */
export function markInContext(docText: string, tokens: Token[], chunk: Chunk, from: number, to: number): string {
  const first = tokens[Math.max(chunk.tokenStart, from - CONTEXT_WINDOW_TOKENS)]!;
  const last = tokens[Math.min(chunk.tokenEnd - 1, to + CONTEXT_WINDOW_TOKENS)]!;
  const marked =
    docText.slice(first.start, tokens[from]!.start) +
    `[[${docText.slice(tokens[from]!.start, tokens[to]!.end)}]]` +
    docText.slice(tokens[to]!.end, last.end);
  return marked.replace(/\s+/g, " ");
}

export function typeCriteria(schema: ExtractionSchema, noneLabel: string, noneText: string, lean = false): Record<string, string | null> {
  const kinds = lean ? Object.fromEntries(Object.keys(schema.entities).map((kind) => [kind, null])) : schema.entities;
  return { ...kinds, [noneLabel]: noneText };
}

export const tagQuestionId = (tokenIndex: number) => `t${tokenIndex}`;

/** One Choice per askable token in the chunk. */
export function buildTagQuestions(
  docText: string,
  tokens: Token[],
  chunk: Chunk,
  schema: ExtractionSchema,
  lean = false,
): Record<string, ChoiceQuestion> {
  const criteria = typeCriteria(schema, NONE, "The word is not part of any named entity.", lean);
  const questions: Record<string, ChoiceQuestion> = {};
  for (const token of tokens.slice(chunk.tokenStart, chunk.tokenEnd)) {
    if (!isAskable(token)) continue;
    questions[tagQuestionId(token.index)] = choice(
      {
        // Read literally, "Lisbon" is a location even inside "Lisbon Climate Forum", which splits the
        // event's name in two. The second sentence tells the model to answer for the whole name.
        task:
          `Decide which kind of named entity the word marked with [[ ]] is part of, as it is used in \`text\`.${lean ? " The kinds are defined in `kinds`." : ""} ` +
          "If the word is one word of a longer name, answer with the kind of the longer name: 'York' in 'New York Times' is part of an organization.",
        word: token.text,
        marked_in_context: markInContext(docText, tokens, chunk, token.index, token.index),
      },
      criteria,
    );
  }
  return questions;
}

export function decideTag(token: number, probabilities: Record<string, number>, threshold: number): TokenTag {
  const pEntity = 1 - (probabilities[NONE] ?? 0);
  let type: string | null = null;
  let best = -1;
  for (const [label, p] of Object.entries(probabilities)) {
    if (label !== NONE && p > best) [type, best] = [label, p];
  }
  return { token, probabilities, pEntity, type: pEntity >= threshold ? type : null };
}

export async function tagChunk(
  jev: Jev,
  docText: string,
  tokens: Token[],
  chunk: Chunk,
  schema: ExtractionSchema,
  tokenThreshold: number,
  lean = false,
): Promise<TokenTag[]> {
  const questions = buildTagQuestions(docText, tokens, chunk, schema, lean);
  const answers = await jev.ask(leanState(chunk, schema, lean), questions, { stage: "ner_tag", chunkId: chunk.id });
  const tags: TokenTag[] = [];
  for (const token of tokens.slice(chunk.tokenStart, chunk.tokenEnd)) {
    const answer = answers[tagQuestionId(token.index)];
    if (answer) tags.push(decideTag(token.index, { ...answer.probabilities }, tokenThreshold));
  }
  return tags;
}
