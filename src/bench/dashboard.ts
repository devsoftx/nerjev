import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Accuracy } from "../eval/evaluate.js";
import type { GoldScore, JudgeCheck } from "../eval/gold.js";
import type { DocumentText, Mention, RunManifest, Stage } from "../types.js";
import { costOf, type PriceTable } from "./pricing.js";
import { readCalls } from "./recorder.js";
import { callStats, quantile } from "./report.js";
import { VARIANTS } from "./runner.js";

export const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL("../../assets/dashboard.template.html", import.meta.url));

const JEV_STAGES: Stage[] = ["ner_tag", "ner_resolve", "ner_type", "entity_align", "relation"];

/** Hand-written commentary that travels with a benchmark: what was found, what was fixed, what to distrust. */
export interface DashboardNotes {
  subtitle?: string;
  documents?: Record<string, { label: string; description: string }>;
  findings: { title: string; detail: string; status: "fixed" | "open" | "by design" | "finding" }[];
  caveats: string[];
}

interface StageRow {
  stage: Stage;
  callsPerRun: number;
  inputTokensPerRun: number;
  latencyP50: number | null;
  latencyP95: number | null;
  questionsMedian: number | null;
  questionsPerRun: number;
  requestKiBPerCall: number;
  responseKiBPerCall: number;
  costPerRun: number | null;
  retried: number;
  rateLimited: number;
  failed: number;
}

interface ResultRow {
  docId: string;
  variant: string;
  /** The model that answered the questions in this variant, as its responses reported it. */
  model: string;
  repetitions: number;
  wallSeconds: { mean: number; min: number; max: number };
  pagesPerMinute: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  payloadKiB: number;
  counts: { chunks: number; mentions: number; review: number; entities: number; relations: number; graphRelations: number };
  stages: StageRow[];
  judge: { calls: number; chunksJudged: number; costUsd: number | null; latencyP50: number | null; latencyP95: number | null; inputTokens: number; outputTokens: number } | null;
  accuracy: Accuracy | null;
}

export interface DashboardData {
  generatedAt: string;
  benchmark: string;
  /** Every model that answered extraction questions, in variant order. */
  extractorModels: string[];
  judgeModel: string | null;
  pricingAsOf: string;
  notes: DashboardNotes;
  documents: { id: string; label: string; description: string; pages: number; skippedPages: number[]; characters: number }[];
  variants: { name: string; chunkSize: number; resolve: boolean; kindsInState?: boolean; actor?: "jev" | "claude" }[];
  results: ResultRow[];
  gold: { passages: number; scores: Record<string, Omit<GoldScore, "errors">> };
  judgeCheck: JudgeCheck | null;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
const kib = (bytes: number) => bytes / 1024;

export function buildDashboardData(benchDir: string, pricing: PriceTable, notes: DashboardNotes, judgeCheck: JudgeCheck | null): DashboardData {
  const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
  const runsDir = join(benchDir, "runs");
  const runs = readdirSync(runsDir)
    .sort()
    .filter((name) => existsSync(join(runsDir, name, "manifest.json")))
    .map((name) => {
      const dir = join(runsDir, name);
      const accuracyPath = join(dir, "accuracy.json");
      return {
        manifest: read<RunManifest>(join(dir, "manifest.json")),
        calls: readCalls(join(dir, "calls.jsonl")),
        accuracy: existsSync(accuracyPath) ? read<Accuracy>(accuracyPath) : null,
        document: read<DocumentText>(join(dir, "document.json")),
        mentions: read<Mention[]>(join(dir, "mentions.json")),
      };
    });
  if (!runs.length) throw new Error(`${benchDir} has no runs`);

  const documents = new Map<string, DashboardData["documents"][number]>();
  for (const { document } of runs) {
    const note = notes.documents?.[document.id];
    documents.set(document.id, {
      id: document.id,
      label: note?.label ?? document.title,
      description: note?.description ?? "",
      pages: document.pageCount,
      skippedPages: document.skippedPages,
      characters: document.text.length,
    });
  }

  const groups = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = `${run.manifest.docId}|${run.manifest.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const results: ResultRow[] = [...groups.values()].map((group) => {
    const first = group[0]!;
    const pages = first.document.pageCount;
    const jevCalls = group.map((r) => r.calls.filter((c) => JEV_STAGES.includes(c.stage)));
    const stats = jevCalls.map((calls) => callStats(calls, pricing));
    const wall = group.map((r) => (r.manifest.wallMs ?? 0) / 1000);
    const costs = stats.map((s) => s.cost).filter((c): c is number => c !== null);

    const stages: StageRow[] = JEV_STAGES.flatMap((stage) => {
      const calls = jevCalls.flat().filter((c) => c.stage === stage);
      if (!calls.length) return [];
      const s = callStats(calls, pricing);
      return [{
        stage,
        callsPerRun: s.calls / group.length,
        inputTokensPerRun: s.inputTokens / group.length,
        latencyP50: s.latencyP50,
        latencyP95: s.latencyP95,
        questionsMedian: s.questionsMedian,
        questionsPerRun: calls.reduce((sum, c) => sum + (c.cached ? 0 : (c.questionCount ?? 0)), 0) / group.length,
        requestKiBPerCall: kib(s.requestBytes) / Math.max(1, s.calls),
        responseKiBPerCall: kib(s.responseBytes) / Math.max(1, s.calls),
        costPerRun: s.cost === null ? null : s.cost / group.length,
        retried: s.retried,
        rateLimited: s.rateLimited,
        failed: s.failed,
      }];
    });

    const judged = group.find((r) => r.accuracy);
    const judgeCalls = judged?.calls.filter((c) => c.stage === "judge") ?? [];
    const judgeCosts = judgeCalls.map((c) => costOf(pricing, c));
    const latencies = judgeCalls.map((c) => c.latencyMs).filter((v): v is number => v !== null);

    return {
      docId: first.manifest.docId,
      variant: first.manifest.variant,
      model: first.calls.find((c) => JEV_STAGES.includes(c.stage) && !c.cached)?.model ?? first.manifest.model,
      repetitions: group.length,
      wallSeconds: { mean: mean(wall), min: Math.min(...wall), max: Math.max(...wall) },
      pagesPerMinute: mean(wall) > 0 ? (pages / mean(wall)) * 60 : null,
      calls: mean(stats.map((s) => s.calls)),
      inputTokens: mean(stats.map((s) => s.inputTokens)),
      outputTokens: mean(stats.map((s) => s.outputTokens)),
      costUsd: costs.length === stats.length ? mean(costs) : null,
      payloadKiB: mean(stats.map((s) => kib(s.requestBytes + s.responseBytes))),
      counts: {
        chunks: first.manifest.counts?.chunks ?? 0,
        mentions: first.mentions.length,
        review: first.mentions.filter((m) => m.status === "review").length,
        entities: first.manifest.counts?.entities ?? 0,
        relations: first.manifest.counts?.relations ?? 0,
        graphRelations: first.manifest.counts?.graphRelations ?? 0,
      },
      stages,
      judge: judged
        ? {
            calls: judgeCalls.length,
            chunksJudged: judged.accuracy!.judge.chunksJudged,
            costUsd: judgeCosts.some((c) => c === null) ? null : judgeCosts.reduce<number>((sum, c) => sum + (c ?? 0), 0),
            latencyP50: quantile(latencies, 0.5),
            latencyP95: quantile(latencies, 0.95),
            inputTokens: judgeCalls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
            outputTokens: judgeCalls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
          }
        : null,
      accuracy: judged?.accuracy ?? null,
    };
  });

  const goldPath = join(benchDir, "gold.json");
  const goldFile = existsSync(goldPath) ? read<{ passages: number; scores: Record<string, GoldScore> }>(goldPath) : { passages: 0, scores: {} };
  const gold = Object.fromEntries(Object.entries(goldFile.scores).map(([variant, score]) => [variant, { entity: score.entity, relation: score.relation }]));

  const variantOrder = VARIANTS.map((v) => v.name);
  const seen = new Set(results.map((r) => r.variant));
  return {
    generatedAt: new Date().toISOString(),
    benchmark: benchDir.replace(/\/+$/, "").split("/").pop()!,
    extractorModels: [...new Set(results.map((r) => r.model))],
    judgeModel: results.find((r) => r.accuracy)?.accuracy?.judgeModel ?? null,
    pricingAsOf: pricing.asOf,
    notes,
    documents: [...documents.values()],
    variants: VARIANTS.filter((v) => seen.has(v.name)),
    results: results.sort((a, b) => variantOrder.indexOf(a.variant) - variantOrder.indexOf(b.variant)),
    gold: { passages: goldFile.passages, scores: gold },
    judgeCheck,
  };
}

/** Inlines the data where the template has its placeholder. `<` is escaped so no value can close the script tag. */
export function renderDashboard(data: DashboardData, templatePath: string = DEFAULT_TEMPLATE_PATH): string {
  const template = readFileSync(templatePath, "utf8");
  const marker = "/*__NERJEV_DATA__*/";
  if (!template.includes(marker)) throw new Error(`${templatePath} has no ${marker} placeholder`);
  return template.replace(marker, () => JSON.stringify(data).replace(/</g, "\\u003c"));
}
