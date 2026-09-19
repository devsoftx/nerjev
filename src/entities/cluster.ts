import { createHash } from "node:crypto";
import type { AlignmentDecision, Entity, Mention } from "../types.js";
import { type NameNode, normalizeName } from "./block.js";

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    const [rootA, rootB] = [this.find(a), this.find(b)];
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

export const entityId = (type: string, canonicalName: string) =>
  createHash("sha256").update(`${type}|${normalizeName(canonicalName)}`).digest("hex").slice(0, 16);

/**
 * Only "same" decisions merge. "review" pairs stay apart because a wrong merge is the expensive
 * mistake in a graph: every fact about either entity would then describe both.
 */
export function clusterEntities(nodes: NameNode[], decisions: AlignmentDecision[], mentions: Mention[]): Entity[] {
  const sets = new UnionFind();
  for (const decision of decisions) if (decision.outcome === "same") sets.union(decision.a, decision.b);

  const groups = new Map<string, NameNode[]>();
  for (const node of nodes) {
    const root = sets.find(node.key);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  }

  const mentionById = new Map(mentions.map((m) => [m.id, m]));
  const entities: Entity[] = [];
  for (const group of groups.values()) {
    const surfaces = new Map<string, number>();
    for (const node of group) for (const [text, n] of node.surfaces) surfaces.set(text, (surfaces.get(text) ?? 0) + n);
    // The longest form is the most specific name ("Tim Cook" over "Cook"). A form that starts with a
    // capital or a digit is preferred, so a single bad boundary ("of the Council...") cannot name the
    // entity. Length is measured on the normalized form; then the shorter raw form, then frequency.
    const nameLike = (text: string) => (/^[\p{Lu}\p{N}]/u.test(text) ? 1 : 0);
    const canonicalName = [...surfaces].sort(
      (a, b) =>
        nameLike(b[0]) - nameLike(a[0]) || normalizeName(b[0]).length - normalizeName(a[0]).length || a[0].length - b[0].length || b[1] - a[1],
    )[0]![0];
    const mentionIds = group.flatMap((node) => node.mentionIds);
    const own = mentionIds.map((id) => mentionById.get(id)!).filter(Boolean);
    const type = group[0]!.type;
    entities.push({
      id: entityId(type, canonicalName),
      type,
      canonicalName,
      aliases: [...surfaces.keys()].filter((text) => text !== canonicalName).sort(),
      mentionIds,
      confidence: Math.max(...own.map((m) => m.confidence)),
      pages: [...new Set(own.map((m) => m.page))].sort((a, b) => a - b),
    });
  }
  return entities.sort((a, b) => a.type.localeCompare(b.type) || a.canonicalName.localeCompare(b.canonicalName));
}
