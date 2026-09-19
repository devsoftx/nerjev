import { createHash } from "node:crypto";
import type { Relation } from "../types.js";
import type { RelationInstance } from "./classify.js";

/** The same (source, relation, target) found in several sentences becomes one edge with all its evidence. */
export function aggregateRelations(instances: RelationInstance[], acceptThreshold: number): Relation[] {
  const grouped = new Map<string, RelationInstance[]>();
  for (const instance of instances) {
    const key = `${instance.sourceId}|${instance.type}|${instance.targetId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), instance]);
  }
  return [...grouped].map(([key, group]) => {
    const confidence = Math.max(...group.map((g) => g.probability));
    const { type, sourceId, targetId } = group[0]!;
    return {
      id: createHash("sha256").update(key).digest("hex").slice(0, 16),
      type,
      sourceId,
      targetId,
      confidence,
      count: group.length,
      evidence: group.map((g) => ({ chunkId: g.chunkId, sentence: g.sentence, page: g.page, probability: g.probability })),
      needsReview: confidence < acceptThreshold,
    };
  });
}
