import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "../entities/block.js";
import type { ExtractionSchema } from "../schema.js";
import type { Chunk, DocumentText, Entity, Mention, Relation, RunManifest, Sentence } from "../types.js";
import type { Judge } from "./judge.js";
import {
  calibration,
  type Calibration,
  entityMetrics,
  type MentionVerdict,
  type Prf,
  relationCorrect,
  relationMetrics,
  type RelationVerdict,
  relaxedCorrect,
  strictCorrect,
  typeAccuracy,
  verdictAgreement,
} from "./metrics.js";
import type { ChunkVerdicts, JudgedMention, JudgedRelation } from "./rubric.js";

const SELF_AGREEMENT_SHARE = 0.1;
const MAX_CLUSTERS_JUDGED = 30;

export interface RunArtifacts {
  manifest: RunManifest;
  doc: DocumentText;
  sentences: Sentence[];
  chunks: Chunk[];
  mentions: Mention[];
  entities: Entity[];
  relations: Relation[];
}

export function loadRun(runDir: string): RunArtifacts {
  const read = <T>(name: string) => JSON.parse(readFileSync(join(runDir, name), "utf8")) as T;
  const segments = read<{ sentences: Sentence[]; chunks: Chunk[] }>("segments.json");
  return {
    manifest: read<RunManifest>("manifest.json"),
    doc: read<DocumentText>("document.json"),
    sentences: segments.sentences,
    chunks: segments.chunks,
    mentions: read<Mention[]>("mentions.json"),
    entities: read<{ entities: Entity[] }>("entities.json").entities,
    relations: read<Relation[]>("relations.json"),
  };
}

export interface Accuracy {
  runId: string;
  variant: string;
  extractorModel: string;
  judgeModel: string;
  entityStrict: Prf;
  entityRelaxed: Prf;
  relation: Prf;
  typeAccuracy: number | null;
  clusterPurity: { judged: number; pure: number; purity: number | null };
  calibration: { mentions: Calibration; relations: Calibration };
  judge: {
    chunksJudged: number;
    chunksFailed: number;
    errors: string[];
    missingVerdicts: number;
    /** Misses the judge quoted that are not in the passage, or that overlap something already extracted. */
    discardedMisses: number;
    selfAgreement: number | null;
    selfAgreementVerdicts: number;
  };
  note: string;
}

export interface ChunkJudgement {
  chunkId: string;
  mentionVerdicts: MentionVerdict[];
  relationVerdicts: RelationVerdict[];
  missedEntities: { quote: string; type: string }[];
  missedRelations: { source_quote: string; relation: string; target_quote: string }[];
  discardedMisses: number;
  missingVerdicts: number;
  error: string | null;
  raw: ChunkVerdicts | null;
}

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
}

interface ChunkInput {
  chunk: Chunk;
  mentions: Mention[];
  relations: Relation[];
  judgedMentions: JudgedMention[];
  judgedRelations: JudgedRelation[];
}

function inputsFor(run: RunArtifacts): ChunkInput[] {
  const entityById = new Map(run.entities.map((e) => [e.id, e]));
  return run.chunks.map((chunk) => {
    const mentions = run.mentions.filter((m) => m.chunkId === chunk.id);
    const relations = run.relations.filter((r) => r.evidence.some((e) => e.chunkId === chunk.id));
    return {
      chunk,
      mentions,
      relations,
      judgedMentions: mentions.map((m, i) => ({ id: `m${i + 1}`, text: m.text, type: m.type })),
      judgedRelations: relations.map((r, i) => {
        const source = entityById.get(r.sourceId);
        const target = entityById.get(r.targetId);
        return {
          id: `r${i + 1}`,
          source: source?.canonicalName ?? r.sourceId,
          source_aliases: source?.aliases ?? [],
          relation: r.type,
          target: target?.canonicalName ?? r.targetId,
          target_aliases: target?.aliases ?? [],
        };
      }),
    };
  });
}

/** Turns the judge's raw output into verdict rows, and keeps only the misses that code can verify. */
export function interpret(input: ChunkInput, verdicts: ChunkVerdicts, schema: ExtractionSchema): ChunkJudgement {
  const { chunk, mentions, relations, judgedMentions, judgedRelations } = input;
  let missingVerdicts = 0;
  let discardedMisses = 0;

  const mentionVerdicts: MentionVerdict[] = [];
  mentions.forEach((mention, i) => {
    const verdict = verdicts.mentions.find((v) => v.id === judgedMentions[i]!.id);
    if (!verdict) return void missingVerdicts++;
    mentionVerdicts.push({
      mentionId: mention.id,
      chunkId: chunk.id,
      confidence: mention.confidence,
      accepted: mention.status === "accepted",
      isEntity: verdict.is_entity,
      boundaryExact: verdict.is_entity && verdict.boundary_exact,
      typeCorrect: verdict.is_entity && verdict.type_correct,
    });
  });

  const relationVerdicts: RelationVerdict[] = [];
  relations.forEach((relation, i) => {
    const verdict = verdicts.relations.find((v) => v.id === judgedRelations[i]!.id);
    if (!verdict) return void missingVerdicts++;
    relationVerdicts.push({
      relationId: relation.id,
      chunkId: chunk.id,
      confidence: relation.confidence,
      accepted: !relation.needsReview,
      supported: verdict.supported_by_text,
      typeCorrect: verdict.supported_by_text && verdict.type_correct,
      directionCorrect: verdict.supported_by_text && verdict.direction_correct,
    });
  });

  // A miss must be quoted verbatim from the passage, and must not overlap something that was
  // extracted: a wrong boundary or type on a real entity is already counted through its verdict.
  const missedEntities = verdicts.missed_entities.filter((miss) => {
    const free = occurrences(chunk.text, miss.quote).filter((at) => {
      const start = chunk.start + at;
      const end = start + miss.quote.length;
      return !mentions.some((m) => start < m.end && end > m.start);
    });
    const valid = miss.quote.trim().length > 0 && miss.type in schema.entities && free.length > 0;
    if (!valid) discardedMisses++;
    return valid;
  });

  const names = (r: JudgedRelation, side: "source" | "target") =>
    [r[side], ...r[`${side}_aliases`]].map(normalizeName);
  const missedRelations = verdicts.missed_relations.filter((miss) => {
    const quoted = chunk.text.includes(miss.source_quote) && chunk.text.includes(miss.target_quote);
    const alreadyExtracted = judgedRelations.some(
      (r) =>
        r.relation === miss.relation &&
        names(r, "source").includes(normalizeName(miss.source_quote)) &&
        names(r, "target").includes(normalizeName(miss.target_quote)),
    );
    const valid = quoted && miss.relation in schema.relations && !alreadyExtracted;
    if (!valid) discardedMisses++;
    return valid;
  });

  return { chunkId: chunk.id, mentionVerdicts, relationVerdicts, missedEntities, missedRelations, discardedMisses, missingVerdicts, error: null, raw: verdicts };
}

async function judgeOne(judge: Judge, schema: ExtractionSchema, input: ChunkInput): Promise<ChunkJudgement> {
  const result = await judge.judgeChunk(schema, input.chunk.id, input.chunk.text, input.judgedMentions, input.judgedRelations);
  if (result.ok) return interpret(input, result.value, schema);
  return {
    chunkId: input.chunk.id,
    mentionVerdicts: [],
    relationVerdicts: [],
    missedEntities: [],
    missedRelations: [],
    discardedMisses: 0,
    missingVerdicts: 0,
    error: result.error,
    raw: null,
  };
}

const booleans = (j: ChunkJudgement): Record<string, boolean[]> => ({
  ...Object.fromEntries(j.mentionVerdicts.map((v) => [v.mentionId, [v.isEntity, v.boundaryExact, v.typeCorrect]])),
  ...Object.fromEntries(j.relationVerdicts.map((v) => [`${v.chunkId}:${v.relationId}`, [v.supported, v.typeCorrect, v.directionCorrect]])),
});

export function summarize(run: RunArtifacts, judgeModel: string, judgements: ChunkJudgement[]): Omit<Accuracy, "clusterPurity" | "judge"> {
  const ok = judgements.filter((j) => !j.error);
  const mentionVerdicts = ok.flatMap((j) => j.mentionVerdicts);
  const relationVerdicts = ok.flatMap((j) => j.relationVerdicts);
  const missedEntities = ok.reduce((n, j) => n + j.missedEntities.length, 0);
  const missedRelations = ok.reduce((n, j) => n + j.missedRelations.length, 0);
  return {
    runId: run.manifest.runId,
    variant: run.manifest.variant,
    extractorModel: run.manifest.model,
    judgeModel,
    entityStrict: entityMetrics(mentionVerdicts, missedEntities, strictCorrect),
    entityRelaxed: entityMetrics(mentionVerdicts, missedEntities, relaxedCorrect),
    relation: relationMetrics(relationVerdicts, missedRelations),
    typeAccuracy: typeAccuracy(mentionVerdicts),
    calibration: {
      mentions: calibration(mentionVerdicts.map((v) => ({ confidence: v.confidence, correct: strictCorrect(v) }))),
      relations: calibration(relationVerdicts.map((v) => ({ confidence: v.confidence, correct: relationCorrect(v) }))),
    },
    note: "Recall and F1 are estimates: misses come from the judge, not from exhaustive annotation. Compare with the gold-set numbers.",
  };
}

export interface EvaluateOptions {
  /** Judge every n-th chunk only. 1 judges all of them. */
  sampleEvery: number;
  log: (message: string) => void;
}

export async function evaluateRun(runDir: string, judge: Judge, schema: ExtractionSchema, options: EvaluateOptions): Promise<Accuracy> {
  const run = loadRun(runDir);
  const inputs = inputsFor(run).filter((_, i) => i % options.sampleEvery === 0);
  options.log(`judging ${inputs.length} of ${run.chunks.length} chunks with ${judge.model}`);

  const judgements = await Promise.all(inputs.map((input) => judgeOne(judge, schema, input)));

  // The same chunks judged a second time give the judge's own noise floor.
  const withItems = inputs.filter((input) => input.mentions.length > 0);
  const repeatCount = withItems.length ? Math.max(1, Math.round(withItems.length * SELF_AGREEMENT_SHARE)) : 0;
  const step = repeatCount ? Math.max(1, Math.floor(withItems.length / repeatCount)) : 1;
  const repeated = withItems.filter((_, i) => i % step === 0).slice(0, repeatCount);
  const second = await Promise.all(repeated.map((input) => judgeOne(judge, schema, input)));
  const first = repeated.map((input) => judgements.find((j) => j.chunkId === input.chunk.id)!);
  const merge = (list: ChunkJudgement[]) => Object.assign({}, ...list.filter((j) => !j.error).map(booleans)) as Record<string, boolean[]>;
  const agreement = verdictAgreement(merge(first), merge(second));

  // Entity resolution: only clusters that actually merged different names are worth judging.
  const mentionById = new Map(run.mentions.map((m) => [m.id, m]));
  const merged = run.entities.filter((e) => new Set([e.canonicalName, ...e.aliases].map(normalizeName)).size > 1).slice(0, MAX_CLUSTERS_JUDGED);
  let clusterPurity: Accuracy["clusterPurity"] = { judged: 0, pure: 0, purity: null };
  const errors = judgements.filter((j) => j.error).map((j) => `${j.chunkId}: ${j.error}`);
  if (merged.length) {
    const result = await judge.judgeClusters(
      merged.map((e) => ({
        id: e.id,
        type: e.type,
        names: [e.canonicalName, ...e.aliases],
        contexts: [...new Set(e.mentionIds.map((id) => mentionById.get(id)).filter(Boolean).map((m) => {
          const s = run.sentences[m!.sentence]!;
          return run.doc.text.slice(s.start, s.end);
        }))].slice(0, 4),
      })),
    );
    if (result.ok) {
      const pure = result.value.clusters.filter((c) => c.same_entity).length;
      clusterPurity = { judged: result.value.clusters.length, pure, purity: result.value.clusters.length ? pure / result.value.clusters.length : null };
    } else errors.push(`clusters: ${result.error}`);
  }

  const accuracy: Accuracy = {
    ...summarize(run, judge.model, judgements),
    clusterPurity,
    judge: {
      chunksJudged: judgements.filter((j) => !j.error).length,
      chunksFailed: judgements.filter((j) => j.error).length,
      errors,
      missingVerdicts: judgements.reduce((n, j) => n + j.missingVerdicts, 0),
      discardedMisses: judgements.reduce((n, j) => n + j.discardedMisses, 0),
      selfAgreement: agreement.agreement,
      selfAgreementVerdicts: agreement.compared,
    },
  };

  writeFileSync(join(runDir, "judge.jsonl"), judgements.map((j) => JSON.stringify(j)).join("\n") + "\n");
  writeFileSync(join(runDir, "accuracy.json"), JSON.stringify(accuracy, null, 2));
  return accuracy;
}
