import type { Sentence } from "../types.js";

/** Abbreviations that end in a period without ending the sentence. Shared with the tokenizer. */
export const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "St", "Jr", "Sr", "Inc", "Ltd", "Corp", "Co", "Gen", "Sen",
  "Rep", "Gov", "Lt", "Col", "Capt", "Sgt", "Mt", "Ft", "vs", "etc",
];

/** Abbreviations that are normally followed by a name, so a capital letter next does not mean a new sentence. */
const PRE_NAME = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Gen|Sen|Rep|Gov|Lt|Col|Capt|Sgt|Mt|Ft|vs)\.$/;
/** A lone capital initial, as in "J. K. Rowling". */
const INITIAL = /(?:^|\s)\p{Lu}\.$/u;

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Intl.Segmenter breaks after "Dr." and "J." whenever a capital follows, so segments that end in a
 * pre-name abbreviation or an initial are merged with the segment after them.
 */
export function splitSentences(text: string): Sentence[] {
  const merged: { start: number; end: number }[] = [];
  let carryStart: number | null = null;
  for (const { segment, index } of segmenter.segment(text)) {
    const start: number = carryStart ?? index;
    const end = index + segment.length;
    const soFar = text.slice(start, end).trimEnd();
    if ((PRE_NAME.test(soFar) || INITIAL.test(soFar)) && !/\n\s*$/.test(segment)) {
      carryStart = start;
      continue;
    }
    carryStart = null;
    merged.push({ start, end });
  }
  if (carryStart !== null) merged.push({ start: carryStart, end: text.length });

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
