import type { Chunk, DocumentText, Segmented, Sentence, Token } from "../types.js";
import { splitSentences } from "./sentences.js";
import { isAskable, tokenize } from "./tokenize.js";

const CONTEXT_BEFORE_MAX_CHARS = 300;

/**
 * Text without sentence punctuation (tables, lists) can yield one enormous "sentence". Anything
 * longer than a chunk is cut at token boundaries so a chunk never exceeds the question budget.
 */
function splitLongSentences(text: string, sentences: Sentence[], maxAskable: number): Sentence[] {
  const out: Sentence[] = [];
  const push = (start: number, end: number) => out.push({ index: out.length, start, end });
  for (const sentence of sentences) {
    const tokens = tokenize(text, [sentence]);
    if (tokens.filter(isAskable).length <= maxAskable) {
      push(sentence.start, sentence.end);
      continue;
    }
    let pieceStart = sentence.start;
    let asked = 0;
    for (const token of tokens) {
      if (!isAskable(token)) continue;
      if (asked === maxAskable) {
        push(pieceStart, text.slice(pieceStart, token.start).trimEnd().length + pieceStart);
        pieceStart = token.start;
        asked = 0;
      }
      asked++;
    }
    push(pieceStart, sentence.end);
  }
  return out;
}

export function segment(doc: DocumentText, maxAskable: number): Segmented {
  const sentences = splitLongSentences(doc.text, splitSentences(doc.text), maxAskable);
  const tokens = tokenize(doc.text, sentences);

  const bySentence = new Map<number, Token[]>();
  for (const token of tokens) {
    const list = bySentence.get(token.sentence);
    if (list) list.push(token);
    else bySentence.set(token.sentence, [token]);
  }

  const chunks: Chunk[] = [];
  let first = 0;
  let asked = 0;
  const flush = (endExclusive: number) => {
    if (endExclusive <= first) return;
    const inChunk = sentences.slice(first, endExclusive);
    const chunkTokens = inChunk.flatMap((s) => bySentence.get(s.index) ?? []);
    const start = inChunk[0]!.start;
    const end = inChunk[inChunk.length - 1]!.end;
    const previous = first > 0 ? sentences[first - 1]! : null;
    chunks.push({
      id: `c${String(chunks.length).padStart(4, "0")}`,
      index: chunks.length,
      start,
      end,
      text: doc.text.slice(start, end),
      contextBefore: previous ? doc.text.slice(previous.start, previous.end).slice(-CONTEXT_BEFORE_MAX_CHARS) : "",
      sentenceStart: first,
      sentenceEnd: endExclusive,
      tokenStart: chunkTokens[0]?.index ?? 0,
      tokenEnd: (chunkTokens[chunkTokens.length - 1]?.index ?? -1) + 1,
    });
    first = endExclusive;
    asked = 0;
  };

  sentences.forEach((sentence, i) => {
    const count = (bySentence.get(sentence.index) ?? []).filter(isAskable).length;
    if (asked > 0 && asked + count > maxAskable) flush(i);
    asked += count;
  });
  flush(sentences.length);

  return { sentences, tokens, chunks: chunks.filter((c) => c.tokenEnd > c.tokenStart) };
}
