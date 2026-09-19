import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeName } from "../entities/block.js";
import type { PipelineResult } from "../pipeline.js";
import type { ExtractionSchema } from "../schema.js";
import type { Judge } from "./judge.js";
import { prf, type Prf } from "./metrics.js";
import type { JudgedMention, JudgedRelation } from "./rubric.js";

/**
 * A hand-labelled passage. `entities` lists each distinct surface form once, exactly as written in
 * `text`. Relations name their source and target by one of those surface forms.
 */
const GoldPassage = z.object({
  id: z.string(),
  text: z.string().min(1),
  entities: z.array(z.object({ text: z.string().min(1), type: z.string() })),
  relations: z.array(z.object({ source: z.string(), type: z.string(), target: z.string() })),
});
export type GoldPassage = z.infer<typeof GoldPassage>;

export function loadGold(dir: string, schema: ExtractionSchema): GoldPassage[] {
  const passages = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => z.array(GoldPassage).parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
  for (const passage of passages) {
    for (const entity of passage.entities) {
      if (!passage.text.includes(entity.text)) throw new Error(`gold ${passage.id}: "${entity.text}" is not in the text`);
      if (!(entity.type in schema.entities)) throw new Error(`gold ${passage.id}: unknown entity type "${entity.type}"`);
    }
    const labelled = new Set(passage.entities.map((e) => e.text));
    for (const relation of passage.relations) {
      if (!(relation.type in schema.relations)) throw new Error(`gold ${passage.id}: unknown relation type "${relation.type}"`);
      for (const end of [relation.source, relation.target]) {
        if (!labelled.has(end)) throw new Error(`gold ${passage.id}: relation endpoint "${end}" is not a labelled entity`);
      }
    }
  }
  return passages;
}

export interface GoldScore {
  entity: Prf;
  relation: Prf;
  /** What differed, as "type|text" for entities and "source|type|target" for relations. */
  errors: { passage: string; kind: "entity" | "relation"; error: "false_positive" | "missed"; item: string }[];
}

const count = <T>(predicted: Set<T>, gold: Set<T>): Prf => {
  const tp = [...predicted].filter((item) => gold.has(item)).length;
  return prf(tp, predicted.size - tp, gold.size - tp);
};

/** Exact match with no judge involved: an entity is right when its text and type both equal a gold label. */
export function scoreAgainstGold(passage: GoldPassage, result: PipelineResult): GoldScore {
  const accepted = result.mentions.filter((m) => m.status === "accepted");
  const predictedEntities = new Set(accepted.map((m) => `${m.type}|${m.text}`));
  const goldEntities = new Set(passage.entities.map((e) => `${e.type}|${e.text}`));

  // Relations connect resolved entities, so either end may be known by any of its surface forms.
  const entityById = new Map(result.entities.map((e) => [e.id, e]));
  const forms = (id: string) => {
    const entity = entityById.get(id);
    return entity ? [entity.canonicalName, ...entity.aliases].map(normalizeName) : [];
  };
  const goldRelations = new Set(passage.relations.map((r) => `${normalizeName(r.source)}|${r.type}|${normalizeName(r.target)}`));
  const predictedRelations = new Set<string>();
  for (const relation of result.relations.filter((r) => !r.needsReview)) {
    const matches = forms(relation.sourceId).flatMap((s) => forms(relation.targetId).map((t) => `${s}|${relation.type}|${t}`));
    predictedRelations.add(matches.find((key) => goldRelations.has(key)) ?? matches[0] ?? relation.id);
  }
  const errors: GoldScore["errors"] = [];
  const diff = (kind: "entity" | "relation", predicted: Set<string>, gold: Set<string>) => {
    for (const item of predicted) if (!gold.has(item)) errors.push({ passage: passage.id, kind, error: "false_positive", item });
    for (const item of gold) if (!predicted.has(item)) errors.push({ passage: passage.id, kind, error: "missed", item });
  };
  diff("entity", predictedEntities, goldEntities);
  diff("relation", predictedRelations, goldRelations);
  return { entity: count(predictedEntities, goldEntities), relation: count(predictedRelations, goldRelations), errors };
}

export function sumScores(scores: GoldScore[]): GoldScore {
  const add = (pick: (s: GoldScore) => Prf) =>
    prf(
      scores.reduce((n, s) => n + pick(s).tp, 0),
      scores.reduce((n, s) => n + pick(s).fp, 0),
      scores.reduce((n, s) => n + pick(s).fn, 0),
    );
  return { entity: add((s) => s.entity), relation: add((s) => s.relation), errors: scores.flatMap((s) => s.errors) };
}

export interface JudgeCheck {
  judgeModel: string;
  passages: number;
  /** Gold labels shown as the extraction: every verdict should be true and nothing should be reported missed. */
  goldAgreement: { agreed: number; total: number; rate: number | null };
  /** Known negatives. Each must fail for the judge to be usable. */
  negatives: {
    shuffledTypesCaught: { caught: number; total: number };
    foreignExtractionCaught: { caught: number; total: number };
    emptyExtractionMissesFound: { found: number; total: number };
  };
  errors: string[];
  passed: boolean;
}

const AGREEMENT_FLOOR = 0.9;

/** Calibrates the judge against human labels before its scores are used for anything. */
export async function checkJudge(judge: Judge, schema: ExtractionSchema, gold: GoldPassage[]): Promise<JudgeCheck> {
  const types = Object.keys(schema.entities);
  const errors: string[] = [];
  const tally = { agreed: 0, total: 0, shuffled: 0, shuffledTotal: 0, foreign: 0, foreignTotal: 0, found: 0, foundTotal: 0 };

  const asMentions = (p: GoldPassage, retype?: (type: string) => string): JudgedMention[] =>
    p.entities.map((e, i) => ({ id: `m${i + 1}`, text: e.text, type: retype ? retype(e.type) : e.type }));
  const asRelations = (p: GoldPassage): JudgedRelation[] =>
    p.relations.map((r, i) => ({ id: `r${i + 1}`, source: r.source, source_aliases: [], relation: r.type, target: r.target, target_aliases: [] }));

  await Promise.all(
    gold.map(async (passage, index) => {
      const foreign = gold[(index + 1) % gold.length]!;
      const [asGold, shuffled, swapped, empty] = await Promise.all([
        judge.judgeChunk(schema, `${passage.id}:gold`, passage.text, asMentions(passage), asRelations(passage)),
        judge.judgeChunk(schema, `${passage.id}:shuffled`, passage.text, asMentions(passage, (t) => types[(types.indexOf(t) + 1) % types.length]!), []),
        gold.length > 1 ? judge.judgeChunk(schema, `${passage.id}:foreign`, passage.text, asMentions(foreign), []) : null,
        judge.judgeChunk(schema, `${passage.id}:empty`, passage.text, [], []),
      ]);

      if (asGold.ok) {
        for (const v of asGold.value.mentions) {
          tally.total++;
          if (v.is_entity && v.boundary_exact && v.type_correct) tally.agreed++;
        }
        for (const v of asGold.value.relations) {
          tally.total++;
          if (v.supported_by_text && v.type_correct && v.direction_correct) tally.agreed++;
        }
      } else errors.push(`${passage.id} gold: ${asGold.error}`);

      if (shuffled.ok) {
        tally.shuffledTotal += passage.entities.length;
        tally.shuffled += shuffled.value.mentions.filter((v) => !v.type_correct).length;
      } else errors.push(`${passage.id} shuffled: ${shuffled.error}`);

      if (swapped?.ok) {
        // Names that happen to occur in both passages are legitimately entities here, so skip them.
        const absent = foreign.entities.map((e, i) => ({ id: `m${i + 1}`, e })).filter(({ e }) => !passage.text.includes(e.text));
        tally.foreignTotal += absent.length;
        tally.foreign += absent.filter(({ id }) => swapped.value.mentions.find((v) => v.id === id)?.is_entity === false).length;
      } else if (swapped) errors.push(`${passage.id} foreign: ${swapped.error}`);

      if (empty.ok) {
        const quoted = new Set(empty.value.missed_entities.map((m) => normalizeName(m.quote)));
        tally.foundTotal += passage.entities.length;
        tally.found += passage.entities.filter((e) => quoted.has(normalizeName(e.text))).length;
      } else errors.push(`${passage.id} empty: ${empty.error}`);
    }),
  );

  const rate = (n: number, d: number) => (d ? n / d : null);
  const agreement = rate(tally.agreed, tally.total);
  const passed =
    errors.length === 0 &&
    (agreement ?? 0) >= AGREEMENT_FLOOR &&
    (rate(tally.shuffled, tally.shuffledTotal) ?? 0) >= AGREEMENT_FLOOR &&
    (rate(tally.foreign, tally.foreignTotal) ?? 1) >= AGREEMENT_FLOOR &&
    (rate(tally.found, tally.foundTotal) ?? 0) >= AGREEMENT_FLOOR;
  return {
    judgeModel: judge.model,
    passages: gold.length,
    goldAgreement: { agreed: tally.agreed, total: tally.total, rate: agreement },
    negatives: {
      shuffledTypesCaught: { caught: tally.shuffled, total: tally.shuffledTotal },
      foreignExtractionCaught: { caught: tally.foreign, total: tally.foreignTotal },
      emptyExtractionMissesFound: { found: tally.found, total: tally.foundTotal },
    },
    errors,
    passed,
  };
}
