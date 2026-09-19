import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import pLimit from "p-limit";
import { Recorder } from "./bench/recorder.js";
import { alignPair } from "./entities/align.js";
import { buildNodes, candidatePairs } from "./entities/block.js";
import { clusterEntities } from "./entities/cluster.js";
import { JevCache } from "./jev/cache.js";
import { Jev } from "./jev/client.js";
import { assembleSpans } from "./ner/assemble.js";
import { DEFAULT_THRESHOLDS, resolveSpans, spansToMentions, type Thresholds } from "./ner/resolve.js";
import { tagChunk } from "./ner/tag.js";
import { aggregateRelations } from "./relations/aggregate.js";
import { pairCandidates } from "./relations/candidates.js";
import { classifyRelations } from "./relations/classify.js";
import type { ExtractionSchema } from "./schema.js";
import { segment } from "./text/chunk.js";
import type { AlignmentDecision, CallRecord, DocumentText, Entity, GraphData, Mention, Relation, RunManifest, Segmented, Span, TokenTag } from "./types.js";

export interface PipelineOptions {
  schema: ExtractionSchema;
  schemaPath: string;
  model: string;
  variant: string;
  /** Askable tokens per chunk. */
  chunkSize: number;
  /** Stage 3c. Off means spans become mentions as assembled. */
  resolve: boolean;
  thresholds: Thresholds;
  includeReview: boolean;
  concurrency: number;
  /** Directory for the Jev response cache, or null to call the API every time. */
  cacheDir: string | null;
  /** Parent directory for the run's artifacts, or null to keep everything in memory. */
  outDir: string | null;
  maxAlignPairs: number;
  log: (message: string) => void;
}

export const DEFAULT_OPTIONS = {
  variant: "default",
  chunkSize: 80,
  resolve: true,
  thresholds: DEFAULT_THRESHOLDS,
  includeReview: false,
  concurrency: 6,
  maxAlignPairs: 300,
} satisfies Partial<PipelineOptions>;

export interface PipelineResult {
  manifest: RunManifest;
  runDir: string | null;
  doc: DocumentText;
  segmented: Segmented;
  tags: TokenTag[];
  spans: Span[];
  mentions: Mention[];
  entities: Entity[];
  alignment: AlignmentDecision[];
  relations: Relation[];
  graph: GraphData;
  calls: CallRecord[];
}

export function newRunId(docId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  return `${stamp}-${docId.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Stages 2 to 5 for one document. Stage 1 (PDF) happens before, stage 6 (graph) after. */
export async function runPipeline(doc: DocumentText, client: TypeSafeClient, options: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const runId = newRunId(doc.id);
  const runDir = options.outDir ? join(options.outDir, runId) : null;
  if (runDir) mkdirSync(runDir, { recursive: true });
  const write = (name: string, data: unknown) => {
    if (runDir) writeFileSync(join(runDir, name), JSON.stringify(data, null, 2));
  };

  const manifest: RunManifest = {
    runId,
    docId: doc.id,
    variant: options.variant,
    model: options.model,
    schemaPath: options.schemaPath,
    options: {
      chunkSize: options.chunkSize,
      resolve: options.resolve,
      thresholds: options.thresholds,
      includeReview: options.includeReview,
      concurrency: options.concurrency,
      cache: options.cacheDir !== null,
    },
    startedAt: new Date(started).toISOString(),
  };

  const recorder = new Recorder(runDir ? join(runDir, "calls.jsonl") : null, { runId, variant: options.variant, docId: doc.id });
  const jev = new Jev({
    client,
    model: options.model,
    recorder,
    limit: pLimit(options.concurrency),
    cache: options.cacheDir ? new JevCache(options.cacheDir) : null,
  });
  const { schema, thresholds } = options;

  // Stage 2
  const segmented = segment(doc, options.chunkSize);
  const { sentences, tokens, chunks } = segmented;
  write("document.json", doc);
  write("segments.json", { sentences, chunks, tokenCount: tokens.length });
  options.log(`${chunks.length} chunks, ${sentences.length} sentences, ${tokens.length} tokens`);

  // Stage 3: every chunk starts at once; the limiter inside Jev bounds the requests in flight.
  const perChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const tags = await tagChunk(jev, doc.text, tokens, chunk, schema, thresholds.token);
      const spans = assembleSpans(doc.text, tokens, chunk, tags);
      const mentions = options.resolve
        ? await resolveSpans(jev, doc.text, tokens, chunk, spans, schema, doc.pageMap, thresholds)
        : spansToMentions(chunk, spans, tokens, doc.pageMap, thresholds);
      return { tags, spans, mentions };
    }),
  );
  const tags = perChunk.flatMap((c) => c.tags);
  const spans = perChunk.flatMap((c) => c.spans);
  const mentions = perChunk.flatMap((c) => c.mentions);
  write("tags.json", tags);
  write("mentions.json", mentions);
  options.log(`${mentions.length} mentions (${mentions.filter((m) => m.status === "review").length} flagged for review)`);

  // Stage 4
  const usable = mentions.filter((m) => options.includeReview || m.status === "accepted");
  const sentenceText = (m: Mention) => doc.text.slice(sentences[m.sentence]!.start, sentences[m.sentence]!.end);
  const nodes = buildNodes(usable, sentenceText);
  const { pairs, dropped } = candidatePairs(nodes, schema, options.maxAlignPairs);
  if (dropped) options.log(`entity resolution: ${dropped} candidate pairs over the cap of ${options.maxAlignPairs} were not checked`);
  const alignment = await Promise.all(pairs.map(([a, b]) => alignPair(jev, a, b)));
  const entities = clusterEntities(nodes, alignment, usable);
  write("entities.json", { entities, alignment });
  options.log(`${entities.length} entities from ${usable.length} mentions (${alignment.filter((d) => d.outcome === "same").length} merges, ${alignment.filter((d) => d.outcome === "review").length} left for review)`);

  // Stage 5
  const entityOf = new Map(entities.flatMap((e) => e.mentionIds.map((id) => [id, e.id] as const)));
  const instances = (
    await Promise.all(
      chunks.map(async (chunk) => {
        const found = pairCandidates(doc.text, chunk, sentences, usable, entityOf, schema);
        if (found.dropped) options.log(`${chunk.id}: ${found.dropped} entity pairs over the per-sentence cap were skipped`);
        return classifyRelations(jev, chunk, found.pairs, thresholds.review);
      }),
    )
  ).flat();
  const relations = aggregateRelations(instances, thresholds.accept);
  write("relations.json", relations);
  options.log(`${relations.length} relations (${relations.filter((r) => r.needsReview).length} flagged for review)`);

  const graph: GraphData = {
    runId,
    model: options.model,
    document: { id: doc.id, sha256: doc.sha256, path: doc.path, title: doc.title, pageCount: doc.pageCount },
    entities,
    relations: relations.filter((r) => options.includeReview || !r.needsReview),
    mentions: usable,
  };
  write("graph.json", graph);

  manifest.finishedAt = new Date().toISOString();
  manifest.wallMs = Date.now() - started;
  manifest.counts = {
    pages: doc.pageCount,
    chunks: chunks.length,
    tokens: tokens.length,
    mentions: mentions.length,
    entities: entities.length,
    relations: relations.length,
    graphRelations: graph.relations.length,
    calls: recorder.rows.length,
  };
  write("manifest.json", manifest);

  return { manifest, runDir, doc, segmented, tags, spans, mentions, entities, alignment, relations, graph, calls: recorder.rows };
}
