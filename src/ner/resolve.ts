import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { Jev } from "../jev/client.js";
import type { ExtractionSchema } from "../schema.js";
import { pageAt } from "../text/normalize.js";
import { isAskable } from "../text/tokenize.js";
import type { Chunk, Mention, PageSpan, Span, Token } from "../types.js";
import { isLeadingArticle } from "./assemble.js";
import { chunkState, markInContext, NONE, typeCriteria } from "./tag.js";

export const NOT_AN_ENTITY = "not_an_entity";
const MAX_GROW = 2;
const MAX_NEIGHBOUR_GAP = 2;
const MAX_CANDIDATE_TOKENS = 12;

export interface Thresholds {
  token: number;
  accept: number;
  review: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { token: 0.5, accept: 0.7, review: 0.4 };

export interface BoundaryCandidate {
  text: string;
  tokenStart: number;
  tokenEnd: number;
  start: number;
  end: number;
}

/**
 * Verbatim alternatives for a span's boundary: the span itself first, then the span grown by up to
 * two tokens per side, shrunk by one per side, and joined with a neighbouring span. Jev picks one and
 * code copies it, so a boundary fix can never contain text that is not in the document.
 */
export function boundaryCandidates(span: Span, spans: Span[], tokens: Token[], chunk: Chunk, docText: string): BoundaryCandidate[] {
  const sentence = tokens[span.tokenStart]!.sentence;
  const ranges: [number, number][] = [[span.tokenStart, span.tokenEnd]];
  for (let left = 0; left <= MAX_GROW; left++) {
    for (let right = 0; right <= MAX_GROW; right++) ranges.push([span.tokenStart - left, span.tokenEnd + right]);
  }
  if (span.tokenEnd > span.tokenStart) {
    ranges.push([span.tokenStart + 1, span.tokenEnd], [span.tokenStart, span.tokenEnd - 1]);
  }
  for (const other of spans) {
    if (other === span) continue;
    const gapBefore = span.tokenStart - other.tokenEnd - 1;
    const gapAfter = other.tokenStart - span.tokenEnd - 1;
    if (gapBefore >= 0 && gapBefore <= MAX_NEIGHBOUR_GAP) ranges.push([other.tokenStart, span.tokenEnd]);
    if (gapAfter >= 0 && gapAfter <= MAX_NEIGHBOUR_GAP) ranges.push([span.tokenStart, other.tokenEnd]);
  }

  const seen = new Set<string>();
  const candidates: BoundaryCandidate[] = [];
  for (let [from, to] of ranges) {
    if (from < chunk.tokenStart || to >= chunk.tokenEnd) continue;
    // A grown edge may land on punctuation or an article; pull it back in to the nearest word.
    while (from < to && (!isAskable(tokens[from]!) || isLeadingArticle(tokens, tokens[from]!))) from++;
    while (to > from && !isAskable(tokens[to]!)) to--;
    const first = tokens[from]!;
    const last = tokens[to]!;
    if (!isAskable(first) || !isAskable(last)) continue;
    if (first.sentence !== sentence || last.sentence !== sentence) continue;
    if (to - from + 1 > MAX_CANDIDATE_TOKENS) continue;
    const text = docText.slice(first.start, last.end);
    if (text === NONE || /\n/.test(text) || seen.has(text)) continue;
    seen.add(text);
    candidates.push({ text, tokenStart: from, tokenEnd: to, start: first.start, end: last.end });
  }
  return candidates;
}

export const boundaryQuestionId = (i: number) => `b${i}`;
export const typeQuestionId = (i: number) => `y${i}`;

/** First request of stage 3c: one boundary Choice per span, whose options are verbatim candidate phrases. */
export function buildBoundaryQuestions(
  docText: string,
  tokens: Token[],
  chunk: Chunk,
  spans: Span[],
  schema: ExtractionSchema,
): { questions: Record<string, ChoiceQuestion>; candidates: BoundaryCandidate[][] } {
  const questions: Record<string, ChoiceQuestion> = {};
  const candidates: BoundaryCandidate[][] = [];
  spans.forEach((span, i) => {
    const options = boundaryCandidates(span, spans, tokens, chunk, docText);
    candidates.push(options);
    questions[boundaryQuestionId(i)] = choice(
      {
        // "Named entity" alone is read literally: a year is not a name, so dates were being answered
        // "none". Listing the kinds makes the schema, not the phrase, define what counts.
        task:
          "The words marked with [[ ]] are part of a mention of one of the `kinds` listed here. Pick the phrase that is exactly that mention as written, with no missing words. " +
          "Leave out a leading article (the, a, an), titles such as Dr. or Mr., and generic words around a name such as company, drone or app, unless they are part of the official name.",
        kinds: schema.entities,
        marked_in_context: markInContext(docText, tokens, chunk, span.tokenStart, span.tokenEnd),
      },
      {
        ...Object.fromEntries(options.map((option) => [option.text, null])),
        [NONE]: "The marked words are not part of a mention of any of these kinds.",
      },
    );
  });
  return { questions, candidates };
}

/**
 * Second request: the type of each phrase that survived. It has to come after the boundary answers,
 * because a fragment's type is not the type of the name it belongs to: "Dubai" is a location, and
 * "Dubai Supply Chain Expo" is an event.
 */
export function buildTypeQuestions(
  docText: string,
  tokens: Token[],
  chunk: Chunk,
  phrases: BoundaryCandidate[],
  schema: ExtractionSchema,
): Record<string, ChoiceQuestion> {
  const types = typeCriteria(schema, NOT_AN_ENTITY, "The phrase is not a named entity of any of these kinds.");
  return Object.fromEntries(
    phrases.map((phrase, i) => [
      typeQuestionId(i),
      choice(
        {
          task: "Decide which kind of named entity the phrase marked with [[ ]] is, as it is used in `text`.",
          phrase: phrase.text,
          marked_in_context: markInContext(docText, tokens, chunk, phrase.tokenStart, phrase.tokenEnd),
        },
        types,
      ),
    ]),
  );
}

interface Draft extends Omit<Mention, "id"> {}

/**
 * Identical spans dedupe. Among overlapping spans an accepted one beats a review-band one, then the
 * longer wins: a fragment's boundary question is biased towards keeping the fragment, so when
 * another span already resolved to the full name ("Lisbon Climate Forum" over "Climate Forum"), the
 * full name is the better reading. Confidence breaks the remaining ties.
 */
export function dropOverlaps<T extends { start: number; end: number; confidence: number }>(items: T[], acceptThreshold: number): T[] {
  const kept: T[] = [];
  const accepted = (item: T) => (item.confidence >= acceptThreshold ? 1 : 0);
  const length = (item: T) => item.end - item.start;
  for (const item of [...items].sort((a, b) => accepted(b) - accepted(a) || length(b) - length(a) || b.confidence - a.confidence)) {
    if (kept.every((other) => item.end <= other.start || item.start >= other.end)) kept.push(item);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function finalize(chunk: Chunk, drafts: Draft[], thresholds: Thresholds): Mention[] {
  return dropOverlaps(drafts, thresholds.accept).map((draft, i) => ({ id: `${chunk.id}-m${i}`, ...draft }));
}

const statusFor = (confidence: number, thresholds: Thresholds) => (confidence >= thresholds.accept ? "accepted" : "review");

/** Stage 3c: a boundary request, overlap handling in code, then a type request for the phrases that remain. */
export async function resolveSpans(
  jev: Jev,
  docText: string,
  tokens: Token[],
  chunk: Chunk,
  spans: Span[],
  schema: ExtractionSchema,
  pageMap: PageSpan[],
  thresholds: Thresholds,
): Promise<Mention[]> {
  if (!spans.length) return [];
  const { questions, candidates } = buildBoundaryQuestions(docText, tokens, chunk, spans, schema);
  const boundaries = await jev.ask(chunkState(chunk), questions, { stage: "ner_resolve", chunkId: chunk.id });

  // Probability split between two acceptable boundaries ("Austin" / "Austin, Texas") says nothing
  // about whether this is an entity, so confidence uses P(not none); boundaryP stays diagnostic.
  const picked: (BoundaryCandidate & { confidence: number; boundaryP: number })[] = [];
  spans.forEach((_, i) => {
    const answer = boundaries[boundaryQuestionId(i)];
    if (!answer || answer.choice === NONE) return;
    const candidate = candidates[i]!.find((c) => c.text === answer.choice);
    const entityP = 1 - (answer.probabilities[NONE] ?? 0);
    if (!candidate || entityP < thresholds.review) return;
    picked.push({ ...candidate, confidence: entityP, boundaryP: answer.probabilities[answer.choice] ?? 0 });
  });
  const phrases = dropOverlaps(picked, thresholds.accept);
  if (!phrases.length) return [];

  const types = await jev.ask(chunkState(chunk), buildTypeQuestions(docText, tokens, chunk, phrases, schema), { stage: "ner_type", chunkId: chunk.id });
  const drafts: Draft[] = [];
  phrases.forEach((phrase, i) => {
    const answer = types[typeQuestionId(i)];
    if (!answer || answer.choice === NOT_AN_ENTITY) return;
    const typeP = answer.probabilities[answer.choice] ?? 0;
    const confidence = phrase.confidence * typeP;
    if (confidence < thresholds.review) return;
    drafts.push({
      chunkId: chunk.id,
      sentence: tokens[phrase.tokenStart]!.sentence,
      text: phrase.text,
      start: phrase.start,
      end: phrase.end,
      page: pageAt(pageMap, phrase.start),
      type: answer.choice,
      confidence,
      boundaryP: phrase.boundaryP,
      typeP,
      status: statusFor(confidence, thresholds),
    });
  });
  return finalize(chunk, drafts, thresholds);
}

/** The --no-resolve path: spans become mentions as assembled, scored by their mean token probability. */
export function spansToMentions(chunk: Chunk, spans: Span[], tokens: Token[], pageMap: PageSpan[], thresholds: Thresholds): Mention[] {
  const drafts: Draft[] = spans
    .filter((span) => span.score >= thresholds.review)
    .map((span) => ({
      chunkId: chunk.id,
      sentence: tokens[span.tokenStart]!.sentence,
      text: span.text,
      start: span.start,
      end: span.end,
      page: pageAt(pageMap, span.start),
      type: span.type,
      confidence: span.score,
      boundaryP: null,
      typeP: span.score,
      status: statusFor(span.score, thresholds),
    }));
  return finalize(chunk, drafts, thresholds);
}
