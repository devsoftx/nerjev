import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { evaluateRun } from "../eval/evaluate.js";
import { type GoldPassage, type GoldScore, scoreAgainstGold, sumScores } from "../eval/gold.js";
import type { Judge } from "../eval/judge.js";
import { documentFromText, extractPdf } from "../pdf/extract.js";
import { DEFAULT_OPTIONS, type PipelineOptions, runPipeline } from "../pipeline.js";
import type { ExtractionSchema } from "../schema.js";
import type { PriceTable } from "./pricing.js";
import { readCalls, type RunContext } from "./recorder.js";
import { type BenchData, type BenchRun, buildReport } from "./report.js";
import type { Accuracy } from "../eval/evaluate.js";
import type { RunManifest } from "../types.js";

export interface Variant {
  name: string;
  chunkSize: number;
  resolve: boolean;
}

/** Spec section 8: token tagging alone, and tagging plus span resolution at three chunk sizes. */
export const VARIANTS: Variant[] = [
  { name: "tag-only-80", chunkSize: 80, resolve: false },
  { name: "resolve-40", chunkSize: 40, resolve: true },
  { name: "resolve-80", chunkSize: 80, resolve: true },
  { name: "resolve-160", chunkSize: 160, resolve: true },
];

export interface BenchOptions {
  docsDir: string;
  gold: GoldPassage[];
  outDir: string;
  variants: Variant[];
  repetitions: number;
  concurrency: number;
  model: string;
  schema: ExtractionSchema;
  schemaPath: string;
  pricing: PriceTable;
  /** Builds a judge whose calls are recorded into the given run. Null skips judging, leaving gold-set accuracy only. */
  makeJudge: ((runDir: string, context: RunContext) => Judge) | null;
  judgeSampleEvery: number;
  log: (message: string) => void;
}

export async function runBenchmark(client: TypeSafeClient, options: BenchOptions): Promise<{ reportPath: string; csvPath: string }> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const benchDir = join(options.outDir, `bench-${stamp}`);
  mkdirSync(benchDir, { recursive: true });

  const pdfs = readdirSync(options.docsDir).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  if (!pdfs.length) options.log(`no PDFs in ${options.docsDir}; the report will hold gold-set accuracy only`);
  const documents = await Promise.all(pdfs.map((name) => extractPdf(join(options.docsDir, name))));

  const base = (variant: Variant, outDir: string | null): PipelineOptions => ({
    ...DEFAULT_OPTIONS,
    schema: options.schema,
    schemaPath: options.schemaPath,
    model: options.model,
    variant: variant.name,
    chunkSize: variant.chunkSize,
    resolve: variant.resolve,
    concurrency: options.concurrency,
    // A benchmark measures real calls, so the response cache is never used.
    cacheDir: null,
    outDir,
    log: () => {},
  });

  const runs: BenchRun[] = [];
  const gold: Record<string, GoldScore> = {};
  for (const variant of options.variants) {
    // Runs go one after another: two documents sharing the rate limit would distort each other's latency.
    for (const doc of documents) {
      for (let rep = 0; rep < options.repetitions; rep++) {
        options.log(`${variant.name} · ${doc.title} · repetition ${rep + 1}/${options.repetitions}`);
        const result = await runPipeline(doc, client, base(variant, join(benchDir, "runs")));
        const run: BenchRun = { manifest: result.manifest, calls: result.calls };
        if (options.makeJudge && rep === 0 && result.runDir) {
          const judge = options.makeJudge(result.runDir, { runId: result.manifest.runId, variant: variant.name, docId: doc.id });
          run.accuracy = await evaluateRun(result.runDir, judge, options.schema, { sampleEvery: options.judgeSampleEvery, log: options.log });
          run.calls = readCalls(join(result.runDir, "calls.jsonl"));
        }
        runs.push(run);
      }
    }
    if (options.gold.length) {
      options.log(`${variant.name} · ${options.gold.length} gold passages`);
      const scores: GoldScore[] = [];
      for (const passage of options.gold) {
        const result = await runPipeline(documentFromText(passage.text, passage.id), client, base(variant, null));
        scores.push(scoreAgainstGold(passage, result));
      }
      gold[variant.name] = sumScores(scores);
    }
  }

  writeFileSync(join(benchDir, "calls.jsonl"), runs.flatMap((r) => r.calls).map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(benchDir, "gold.json"), JSON.stringify({ passages: options.gold.length, scores: gold }, null, 2));
  return writeReport(benchDir, { pricing: options.pricing, runs, gold, goldPassages: options.gold.length });
}

function writeReport(benchDir: string, data: BenchData): { reportPath: string; csvPath: string } {
  const { markdown, csv } = buildReport(data);
  const reportPath = join(benchDir, "report.md");
  const csvPath = join(benchDir, "summary.csv");
  writeFileSync(reportPath, markdown);
  writeFileSync(csvPath, csv);
  return { reportPath, csvPath };
}

/**
 * Rebuilds report.md and summary.csv from a finished benchmark's artifacts, with no API calls. This
 * is what makes cost a report-time figure: edit bench/pricing.json, run this, and the costs update.
 */
export function rebuildReport(benchDir: string, pricing: PriceTable): { reportPath: string; csvPath: string } {
  const runsDir = join(benchDir, "runs");
  const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
  const runs: BenchRun[] = readdirSync(runsDir)
    .sort()
    .filter((name) => existsSync(join(runsDir, name, "manifest.json")))
    .map((name) => {
      const dir = join(runsDir, name);
      const accuracyPath = join(dir, "accuracy.json");
      return {
        manifest: read<RunManifest>(join(dir, "manifest.json")),
        calls: readCalls(join(dir, "calls.jsonl")),
        ...(existsSync(accuracyPath) ? { accuracy: read<Accuracy>(accuracyPath) } : {}),
      };
    });
  const goldPath = join(benchDir, "gold.json");
  const gold = existsSync(goldPath) ? read<{ passages: number; scores: Record<string, GoldScore> }>(goldPath) : { passages: 0, scores: {} };
  return writeReport(benchDir, { pricing, runs, gold: gold.scores, goldPassages: gold.passages });
}
