import type { Accuracy } from "../eval/evaluate.js";
import type { GoldScore } from "../eval/gold.js";
import type { Prf } from "../eval/metrics.js";
import type { CallRecord, RunManifest, Stage } from "../types.js";
import { costOf, type PriceTable } from "./pricing.js";

export interface BenchRun {
  manifest: RunManifest;
  calls: CallRecord[];
  accuracy?: Accuracy;
}

export interface BenchData {
  pricing: PriceTable;
  runs: BenchRun[];
  /** Exact-match scores on the hand-labelled passages, per variant. */
  gold: Record<string, GoldScore>;
  goldPassages: number;
}

const PIPELINE_STAGES: Stage[] = ["ner_tag", "ner_resolve", "ner_type", "entity_align", "relation"];

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.ceil(at)]! - sorted[low]!) * (at - low);
}

const sum = (values: (number | null)[]) => values.reduce<number>((total, v) => total + (v ?? 0), 0);
const present = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null);

const fmt = (value: number | null | undefined, digits = 0) =>
  value == null || Number.isNaN(value) ? "n/a" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const usd = (value: number | null | undefined) => (value == null ? "n/a" : `$${value.toFixed(value < 0.01 ? 6 : 4)}`);
const pct = (value: number | null | undefined) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const range = (values: number[], digits = 0) =>
  values.length > 1 ? `${fmt(mean(values), digits)} (${fmt(Math.min(...values), digits)}–${fmt(Math.max(...values), digits)})` : fmt(values[0], digits);

export interface CallStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  inputPerCall: { min: number | null; median: number | null; max: number | null };
  latencyP50: number | null;
  latencyP95: number | null;
  requestBytes: number;
  responseBytes: number;
  questionsMedian: number | null;
  retried: number;
  rateLimited: number;
  failed: number;
  cost: number | null;
  costPerCallMedian: number | null;
}

/** Cached rows are replayed answers, so they are left out of tokens, latency and cost alike. */
export function callStats(calls: CallRecord[], pricing: PriceTable): CallStats {
  const live = calls.filter((c) => !c.cached);
  const inputs = present(live.map((c) => c.inputTokens));
  const costs = live.map((c) => costOf(pricing, c));
  return {
    calls: live.length,
    inputTokens: sum(live.map((c) => c.inputTokens)),
    outputTokens: sum(live.map((c) => c.outputTokens)),
    inputPerCall: { min: inputs.length ? Math.min(...inputs) : null, median: quantile(inputs, 0.5), max: inputs.length ? Math.max(...inputs) : null },
    latencyP50: quantile(present(live.map((c) => c.latencyMs)), 0.5),
    latencyP95: quantile(present(live.map((c) => c.latencyMs)), 0.95),
    requestBytes: sum(live.map((c) => c.requestBytes)),
    responseBytes: sum(live.map((c) => c.responseBytes)),
    questionsMedian: quantile(present(live.map((c) => c.questionCount)), 0.5),
    retried: live.filter((c) => c.attempts > 1).length,
    rateLimited: live.filter((c) => c.statusCodes.some((s) => s === 429 || s === 529)).length,
    failed: live.filter((c) => c.error).length,
    cost: costs.some((c) => c === null) ? null : sum(costs),
    costPerCallMedian: quantile(present(costs), 0.5),
  };
}

const table = (header: string[], rows: string[][]) =>
  [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const prfCells = (p: Prf | undefined) => (p ? [pct(p.precision), pct(p.recall), pct(p.f1)] : ["n/a", "n/a", "n/a"]);
const countCell = (p: Prf | undefined) => (p ? `${p.tp} / ${p.fp} / ${p.fn}` : "n/a");

function groupRuns(runs: BenchRun[]): Map<string, BenchRun[]> {
  const groups = new Map<string, BenchRun[]>();
  for (const run of runs) {
    const key = `${run.manifest.variant}\u0000${run.manifest.docId}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return groups;
}

export function buildReport(data: BenchData): { markdown: string; csv: string } {
  const { pricing } = data;
  const groups = groupRuns(data.runs);
  const pipelineCalls = (run: BenchRun) => run.calls.filter((c) => PIPELINE_STAGES.includes(c.stage));
  const judgeCalls = (run: BenchRun) => run.calls.filter((c) => c.stage === "judge");

  const overview: string[][] = [];
  const csvRows: string[][] = [];
  for (const runs of groups.values()) {
    const { variant, docId } = runs[0]!.manifest;
    const stats = runs.map((r) => callStats(pipelineCalls(r), pricing));
    const counts = runs.map((r) => r.manifest.counts ?? {});
    const pages = counts[0]?.pages ?? 0;
    const wall = runs.map((r) => (r.manifest.wallMs ?? 0) / 1000);
    const cost = present(stats.map((s) => s.cost));
    const entities = mean(counts.map((c) => c.entities ?? 0)) ?? 0;
    const relations = mean(counts.map((c) => c.graphRelations ?? 0)) ?? 0;
    const meanCost = mean(cost);
    const accuracy = runs.find((r) => r.accuracy)?.accuracy;
    const gold = data.gold[variant];

    overview.push([
      variant,
      docId.slice(0, 8),
      String(runs.length),
      fmt(mean(stats.map((s) => s.calls)), 1),
      fmt(mean(stats.map((s) => s.inputTokens))),
      range(wall, 1),
      fmt(mean(wall) ? (pages / mean(wall)!) * 60 : null, 1),
      usd(meanCost),
      usd(meanCost !== null && pages ? meanCost / pages : null),
      fmt(sum(stats.map((s) => s.requestBytes + s.responseBytes)) / runs.length / 1024, 1),
      pct(accuracy?.entityStrict.f1),
      pct(gold?.entity.f1),
    ]);
    csvRows.push([
      variant, docId, String(runs.length), String(pages),
      String(mean(stats.map((s) => s.calls)) ?? ""), String(mean(stats.map((s) => s.inputTokens)) ?? ""), String(mean(stats.map((s) => s.outputTokens)) ?? ""),
      String(mean(wall) ?? ""), String(mean(present(stats.map((s) => s.latencyP50))) ?? ""), String(mean(present(stats.map((s) => s.latencyP95))) ?? ""),
      String(meanCost ?? ""), String(meanCost !== null && pages ? meanCost / pages : ""), String(meanCost !== null && entities ? meanCost / entities : ""), String(meanCost !== null && relations ? meanCost / relations : ""),
      String(mean(stats.map((s) => s.requestBytes)) ?? ""), String(mean(stats.map((s) => s.responseBytes)) ?? ""),
      String(entities), String(relations),
      String(accuracy?.entityStrict.precision ?? ""), String(accuracy?.entityStrict.recall ?? ""), String(accuracy?.entityStrict.f1 ?? ""),
      String(accuracy?.relation.precision ?? ""), String(accuracy?.relation.recall ?? ""), String(accuracy?.relation.f1 ?? ""),
      String(gold?.entity.f1 ?? ""), String(gold?.relation.f1 ?? ""),
      String(sum(stats.map((s) => s.retried))), String(sum(stats.map((s) => s.rateLimited))), String(sum(stats.map((s) => s.failed))),
    ]);
  }

  const stageRows: string[][] = [];
  for (const runs of groups.values()) {
    const { variant, docId } = runs[0]!.manifest;
    for (const stage of [...PIPELINE_STAGES, "judge" as Stage]) {
      const calls = runs.flatMap((r) => r.calls.filter((c) => c.stage === stage));
      if (!calls.length) continue;
      const s = callStats(calls, pricing);
      // Only the first repetition is judged, so per-run figures divide by the runs that have the stage.
      const runsWithStage = runs.filter((r) => r.calls.some((c) => c.stage === stage)).length;
      stageRows.push([
        variant, docId.slice(0, 8), stage, fmt(s.calls / runsWithStage, 1),
        `${fmt(s.inputPerCall.min)} / ${fmt(s.inputPerCall.median)} / ${fmt(s.inputPerCall.max)}`,
        fmt(s.outputTokens / runsWithStage), fmt(s.latencyP50), fmt(s.latencyP95), fmt(s.questionsMedian),
        fmt(s.requestBytes / Math.max(1, s.calls) / 1024, 1), fmt(s.responseBytes / Math.max(1, s.calls) / 1024, 1),
        s.inputTokens ? fmt(s.requestBytes / s.inputTokens, 2) : "n/a",
        usd(s.costPerCallMedian), usd(s.cost === null ? null : s.cost / runsWithStage), `${s.retried} / ${s.rateLimited} / ${s.failed}`,
      ]);
    }
  }

  const accuracyRows: string[][] = [];
  const yieldRows: string[][] = [];
  for (const runs of groups.values()) {
    const { variant, docId } = runs[0]!.manifest;
    const accuracy = runs.find((r) => r.accuracy)?.accuracy;
    const gold = data.gold[variant];
    accuracyRows.push([
      variant, docId.slice(0, 8),
      ...prfCells(accuracy?.entityStrict), countCell(accuracy?.entityStrict), ...prfCells(accuracy?.entityRelaxed), ...prfCells(accuracy?.relation), countCell(accuracy?.relation),
      pct(accuracy?.typeAccuracy), pct(accuracy?.clusterPurity.purity),
      accuracy ? fmt(accuracy.calibration.mentions.ece, 3) : "n/a", pct(accuracy?.judge.selfAgreement),
      ...prfCells(gold?.entity), countCell(gold?.entity), ...prfCells(gold?.relation), countCell(gold?.relation),
    ]);
    const c = runs[0]!.manifest.counts ?? {};
    const pages = c.pages || 1;
    const stats = callStats(pipelineCalls(runs[0]!), pricing);
    const judge = callStats(judgeCalls(runs[0]!), pricing);
    yieldRows.push([
      variant, docId.slice(0, 8), fmt(c.mentions), fmt(c.entities), fmt(c.relations), fmt(c.graphRelations),
      fmt((c.entities ?? 0) / pages, 1), fmt((c.graphRelations ?? 0) / pages, 1),
      usd(stats.cost !== null && c.entities ? stats.cost / c.entities : null),
      usd(stats.cost !== null && c.graphRelations ? stats.cost / c.graphRelations : null),
      usd(judge.calls ? judge.cost : null),
    ]);
  }

  const models = [...new Set(data.runs.flatMap((r) => r.calls.map((c) => c.model)))].sort();
  const unpriced = models.filter((m) => costOf(pricing, { model: m, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false }) === null);

  const markdown = [
    "# nerjev benchmark report",
    "",
    `Generated ${new Date().toISOString()}. Models seen in responses: ${models.join(", ") || "none"}. Prices as of ${pricing.asOf}.`,
    "Every figure comes from recorded API responses. Cost is computed here from recorded tokens and `bench/pricing.json`, so a price change means re-running the report and not the benchmark. Cached calls are excluded. Pipeline cost never includes judge cost.",
    unpriced.length ? `\n**No price for: ${unpriced.join(", ")}. Costs that involve these models show as n/a.**` : "",
    "",
    "## Overview",
    "",
    "One row per variant and document, averaged over repetitions. Wall time shows the mean with its range.",
    "",
    table(["variant", "doc", "reps", "calls", "input tokens", "wall s", "pages/min", "cost", "cost/page", "payload KiB", "entity F1 (judge, strict)", "entity F1 (gold)"], overview),
    "",
    "## Per stage",
    "",
    "Latency is the final successful attempt of each call, in milliseconds, and excludes time queued behind the local concurrency limit. Per-run figures divide by the runs in which the stage ran; the judge grades the first repetition only. The last column counts calls that retried, that met a 429 or 529, and that failed.",
    "",
    table(["variant", "doc", "stage", "calls/run", "input tokens/call min / med / max", "output tokens/run", "p50 ms", "p95 ms", "questions/req", "req KiB/call", "resp KiB/call", "bytes/input token", "cost/call (median)", "cost/run", "retried / limited / failed"], stageRows),
    "",
    "## Accuracy",
    "",
    "Judge columns come from the LLM judge; recall and F1 there are estimates because the list of misses is the judge's. Gold columns are exact match against the hand-labelled passages, with no judge involved. Judge self-agreement is the judge's noise floor: a difference between two variants that is smaller than (100% − self-agreement) should not be read as a difference. The tp / fp / fn columns give the counts behind each percentage: with a few dozen items, one item moves a score by a point or more, so compare counts before comparing percentages.",
    "",
    table(["variant", "doc", "ent P", "ent R", "ent F1", "ent tp / fp / fn", "ent P (relaxed)", "ent R (relaxed)", "ent F1 (relaxed)", "rel P", "rel R", "rel F1", "rel tp / fp / fn", "type acc", "cluster purity", "ECE", "judge self-agreement", "gold ent P", "gold ent R", "gold ent F1", "gold ent tp / fp / fn", "gold rel P", "gold rel R", "gold rel F1", "gold rel tp / fp / fn"], accuracyRows),
    "",
    `Gold set: ${data.goldPassages} passages.`,
    "",
    "## Yield and unit cost",
    "",
    "First repetition of each variant and document.",
    "",
    table(["variant", "doc", "mentions", "entities", "relations", "relations in graph", "entities/page", "relations/page", "cost/entity", "cost/relation", "judge cost (separate)"], yieldRows),
    "",
  ].join("\n");

  const csvHeader = [
    "variant", "docId", "reps", "pages", "calls", "inputTokens", "outputTokens", "wallSeconds", "latencyP50Ms", "latencyP95Ms",
    "costUsd", "costPerPageUsd", "costPerEntityUsd", "costPerRelationUsd", "requestBytes", "responseBytes", "entities", "relationsInGraph",
    "judgeEntityPrecision", "judgeEntityRecall", "judgeEntityF1", "judgeRelationPrecision", "judgeRelationRecall", "judgeRelationF1",
    "goldEntityF1", "goldRelationF1", "callsRetried", "callsRateLimited", "callsFailed",
  ];
  const csv = [csvHeader, ...csvRows].map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n") + "\n";
  return { markdown, csv };
}
