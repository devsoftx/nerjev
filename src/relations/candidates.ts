import type { ExtractionSchema } from "../schema.js";
import type { Chunk, Mention, Sentence } from "../types.js";

export const MAX_PAIRS_PER_SENTENCE = 15;

export interface RelationOption {
  /** Choice option name, e.g. `A_works_for_B` or `B_acquired_A`. */
  label: string;
  relation: string;
  /** True when A is the source of the relation. */
  forward: boolean;
  text: string;
}

export interface PairCandidate {
  chunkId: string;
  sentence: Sentence;
  sentenceText: string;
  a: { mention: Mention; entityId: string };
  b: { mention: Mention; entityId: string };
  options: RelationOption[];
}

/** Rewrites a relation description for the reversed direction by exchanging the placeholders A and B. */
export function swapPlaceholders(text: string): string {
  return text.replace(/\b[AB]\b/g, (letter) => (letter === "A" ? "B" : "A"));
}

/** Directed options the schema allows for this pair of types. Both directions appear when both fit. */
export function optionsFor(schema: ExtractionSchema, typeA: string, typeB: string): RelationOption[] {
  const options: RelationOption[] = [];
  for (const [relation, def] of Object.entries(schema.relations)) {
    if (def.domain.includes(typeA) && def.range.includes(typeB)) {
      options.push({ label: `A_${relation}_B`, relation, forward: true, text: def.text });
    }
    if (def.domain.includes(typeB) && def.range.includes(typeA)) {
      options.push({ label: `B_${relation}_A`, relation, forward: false, text: swapPlaceholders(def.text) });
    }
  }
  return options;
}

/**
 * Pairs of distinct entities mentioned in the same sentence, where the schema has at least one
 * relation fitting their types. Each entity is represented by its first mention in the sentence.
 */
export function pairCandidates(
  docText: string,
  chunk: Chunk,
  sentences: Sentence[],
  mentions: Mention[],
  entityOf: Map<string, string>,
  schema: ExtractionSchema,
): { pairs: PairCandidate[]; dropped: number } {
  const pairs: PairCandidate[] = [];
  let dropped = 0;
  for (const sentence of sentences.slice(chunk.sentenceStart, chunk.sentenceEnd)) {
    const firstByEntity = new Map<string, Mention>();
    for (const mention of mentions.filter((m) => m.sentence === sentence.index).sort((x, y) => x.start - y.start)) {
      const entity = entityOf.get(mention.id);
      if (entity && !firstByEntity.has(entity)) firstByEntity.set(entity, mention);
    }
    const present = [...firstByEntity];
    const inSentence: PairCandidate[] = [];
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const [entityA, mentionA] = present[i]!;
        const [entityB, mentionB] = present[j]!;
        const options = optionsFor(schema, mentionA.type, mentionB.type);
        if (!options.length) continue;
        inSentence.push({
          chunkId: chunk.id,
          sentence,
          sentenceText: docText.slice(sentence.start, sentence.end),
          a: { mention: mentionA, entityId: entityA },
          b: { mention: mentionB, entityId: entityB },
          options,
        });
      }
    }
    dropped += Math.max(0, inSentence.length - MAX_PAIRS_PER_SENTENCE);
    pairs.push(...inSentence.slice(0, MAX_PAIRS_PER_SENTENCE));
  }
  return { pairs, dropped };
}
