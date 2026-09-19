import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { Jev } from "../jev/client.js";
import { chunkState, NONE } from "../ner/tag.js";
import type { Chunk } from "../types.js";
import type { PairCandidate } from "./candidates.js";

export interface RelationInstance {
  type: string;
  sourceId: string;
  targetId: string;
  probability: number;
  chunkId: string;
  sentence: string;
  page: number;
}

export const relationQuestionId = (i: number) => `r${i}`;

export function buildRelationQuestions(pairs: PairCandidate[]): Record<string, ChoiceQuestion> {
  const questions: Record<string, ChoiceQuestion> = {};
  pairs.forEach((pair, i) => {
    questions[relationQuestionId(i)] = choice(
      {
        task: "Which relationship between A and B does the sentence explicitly state?",
        A: `${pair.a.mention.text} (${pair.a.mention.type})`,
        B: `${pair.b.mention.text} (${pair.b.mention.type})`,
        sentence: pair.sentenceText,
      },
      {
        ...Object.fromEntries(pair.options.map((option) => [option.label, option.text])),
        [NONE]: "The sentence does not state any of these relationships between A and B.",
      },
    );
  });
  return questions;
}

/** Stage 5: every pair question for a chunk rides in one request. Instances below `minProbability` are dropped. */
export async function classifyRelations(jev: Jev, chunk: Chunk, pairs: PairCandidate[], minProbability: number): Promise<RelationInstance[]> {
  if (!pairs.length) return [];
  const answers = await jev.ask(chunkState(chunk), buildRelationQuestions(pairs), { stage: "relation", chunkId: chunk.id });
  const instances: RelationInstance[] = [];
  pairs.forEach((pair, i) => {
    const answer = answers[relationQuestionId(i)];
    if (!answer || answer.choice === NONE) return;
    const option = pair.options.find((o) => o.label === answer.choice);
    const probability = answer.probabilities[answer.choice] ?? 0;
    if (!option || probability < minProbability) return;
    const [source, target] = option.forward ? [pair.a, pair.b] : [pair.b, pair.a];
    instances.push({
      type: option.relation,
      sourceId: source.entityId,
      targetId: target.entityId,
      probability,
      chunkId: pair.chunkId,
      sentence: pair.sentenceText,
      page: pair.a.mention.page,
    });
  });
  return instances;
}
