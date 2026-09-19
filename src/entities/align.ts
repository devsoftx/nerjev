import { score } from "@typesafe-ai/sdk";
import type { Jev } from "../jev/client.js";
import type { AlignmentDecision } from "../types.js";
import type { NameNode } from "./block.js";

/**
 * Each level is one thing the pipeline can do with a pair, so rounding to the nearest level is the
 * whole decision rule and there is no threshold to fit (TypeSafe's entity-alignment cookbook).
 */
const LEVELS = [
  "They are two different entities.",
  "They might be the same entity, but the names and contexts do not make it certain.",
  "They are the same entity: one name is a shorter form, full form, abbreviation or spelling variant of the other.",
] as const;
const OUTCOMES = ["different", "review", "same"] as const;

const mostCommonSurface = (node: NameNode) => [...node.surfaces].sort((a, b) => b[1] - a[1])[0]![0];

const describe = (node: NameNode) => ({ name: mostCommonSurface(node), type: node.type, contexts: node.contexts });

export function route(value: number): AlignmentDecision["outcome"] {
  return OUTCOMES[Math.min(OUTCOMES.length - 1, Math.max(0, Math.round(value)))]!;
}

/** One request per pair: the state is the pair, so pairs cannot share a request. */
export async function alignPair(jev: Jev, a: NameNode, b: NameNode): Promise<AlignmentDecision> {
  const answers = await jev.ask(
    { entity_a: describe(a), entity_b: describe(b) },
    { same: score("Do `entity_a` and `entity_b` refer to the same real-world entity in this document?", LEVELS) },
    { stage: "entity_align", chunkId: null },
  );
  const { score: value, confidence } = answers.same;
  return { a: a.key, b: b.key, type: a.type, score: value, confidence, outcome: route(value) };
}
