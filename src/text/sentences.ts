import type { Sentence } from "../types.js";

/** Abbreviations that end in a period without ending the sentence. Shared with the tokenizer. */
export const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "St", "Jr", "Sr", "Inc", "Ltd", "Corp", "Co", "Gen", "Sen",
  "Rep", "Gov", "Lt", "Col", "Capt", "Sgt", "Mt", "Ft", "No", "vs", "etc",
];

/** Abbreviations that are normally followed by a name, so a capital letter next does not mean a new sentence. */
const PRE_NAME = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Gen|Sen|Rep|Gov|Lt|Col|Capt|Sgt|Mt|Ft|vs)\.$/;
/** A lone capital initial, as in "J. K. Rowling". */
const INITIAL = /(?:^|\s)\p{Lu}\.$/u;
/** Abbreviations that introduce a number ("Decision No. 17820", "Art. 5"): no break when a digit follows. */
const BEFORE_NUMBER = /(?:^|\s)(?:No|Nos|Art|Arts|Sec|Para|para|p|pp)\.$/;

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Intl.Segmenter breaks after "Dr." and "J." whenever a capital follows, so segments that end in a
 * pre-name abbreviation or an initial are merged with the segment after them.
 */
export function splitSentences(text: string): Sentence[] {
  const raw = [...segmenter.segment(text)].map(({ segment, index }) => ({ segment, start: index, end: index + segment.length }));
  const merged: { start: number; end: number }[] = [];
  let carryStart: number | null = null;
  raw.forEach((piece, i) => {
    const start: number = carryStart ?? piece.start;
    const soFar = text.slice(start, piece.end).trimEnd();
    const next = raw[i + 1]?.segment ?? "";
    const continues = PRE_NAME.test(soFar) || INITIAL.test(soFar) || (BEFORE_NUMBER.test(soFar) && /^\s*\p{N}/u.test(next));
    if (continues && next && !/\n\s*$/.test(piece.segment)) {
      carryStart = start;
      return;
    }
    carryStart = null;
    merged.push({ start, end: piece.end });
  });

  const sentences: Sentence[] = [];
  for (const { start, end } of merged) {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    sentences.push({ index: sentences.length, start: start + lead, end: start + lead + trimmed.length });
  }
  return sentences;
}
