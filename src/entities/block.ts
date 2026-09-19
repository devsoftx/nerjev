import type { ExtractionSchema } from "../schema.js";
import type { Mention } from "../types.js";

const JARO_WINKLER_MIN = 0.85;
const MAX_CONTEXTS = 2;
const ACRONYM_SKIP = new Set(["of", "the", "and", "for", "de", "la", "&"]);

/** Surface form reduced for comparison: case, a leading article, possessives and punctuation are ignored. */
export function normalizeName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}&\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** All mentions of one type that normalize to the same text. These merge without a model call. */
export interface NameNode {
  key: string;
  type: string;
  normalized: string;
  surfaces: Map<string, number>;
  mentionIds: string[];
  contexts: string[];
}

export function buildNodes(mentions: Mention[], sentenceText: (mention: Mention) => string): NameNode[] {
  const nodes = new Map<string, NameNode>();
  for (const mention of mentions) {
    const normalized = normalizeName(mention.text);
    if (!normalized) continue;
    const key = `${mention.type}|${normalized}`;
    let node = nodes.get(key);
    if (!node) {
      node = { key, type: mention.type, normalized, surfaces: new Map(), mentionIds: [], contexts: [] };
      nodes.set(key, node);
    }
    node.surfaces.set(mention.text, (node.surfaces.get(mention.text) ?? 0) + 1);
    node.mentionIds.push(mention.id);
    const context = sentenceText(mention);
    if (node.contexts.length < MAX_CONTEXTS && !node.contexts.includes(context)) node.contexts.push(context);
  }
  return [...nodes.values()];
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const hi = Math.min(b.length - 1, i + window);
    for (let j = Math.max(0, i - window); j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[j]) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function isTokenSubset(shorter: string[], longer: string[]): boolean {
  return shorter.length < longer.length && shorter.some((t) => t.length > 1) && shorter.every((t) => longer.includes(t));
}

function isAcronymOf(short: string, longTokens: string[]): boolean {
  const letters = short.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 2 || longTokens.length < 2) return false;
  const initials = longTokens.filter((t) => !ACRONYM_SKIP.has(t)).map((t) => t[0]).join("");
  return letters === initials;
}

export type PairReason = "subset" | "acronym" | "similar";

export function pairReason(a: NameNode, b: NameNode): PairReason | null {
  const aTokens = a.normalized.split(" ");
  const bTokens = b.normalized.split(" ");
  if (isTokenSubset(aTokens, bTokens) || isTokenSubset(bTokens, aTokens)) return "subset";
  if (isAcronymOf(a.normalized, bTokens) || isAcronymOf(b.normalized, aTokens)) return "acronym";
  if (jaroWinkler(a.normalized, b.normalized) >= JARO_WINKLER_MIN) return "similar";
  return null;
}

/** Pairs worth a model call. Types listed in exactMatchOnly (dates) never pair: "2004" is not "2005". */
export function candidatePairs(nodes: NameNode[], schema: ExtractionSchema, maxPairs: number): { pairs: [NameNode, NameNode][]; dropped: number } {
  const exactOnly = new Set(schema.exactMatchOnly);
  const pairs: [NameNode, NameNode][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i]!, nodes[j]!];
      if (a.type !== b.type || exactOnly.has(a.type)) continue;
      if (pairReason(a, b)) pairs.push([a, b]);
    }
  }
  return { pairs: pairs.slice(0, maxPairs), dropped: Math.max(0, pairs.length - maxPairs) };
}
