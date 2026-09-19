#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pLimit from "p-limit";
import { buildDashboardData, type DashboardNotes, renderDashboard } from "./bench/dashboard.js";
import { loadPricing } from "./bench/pricing.js";
import { Recorder } from "./bench/recorder.js";
import { callStats } from "./bench/report.js";
import { rebuildReport, runBenchmark, VARIANTS } from "./bench/runner.js";
import { createAnthropic, createTypeSafe, jevModel, judgeModel, loadEnv, MissingKeyError } from "./clients.js";
import { evaluateRun, loadRun } from "./eval/evaluate.js";
import { checkJudge, type JudgeCheck, loadGold, scoreAgainstGold, sumScores } from "./eval/gold.js";
import { Judge } from "./eval/judge.js";
import { CypherExportStore } from "./graph/cypherExport.js";
import { Neo4jStore, neo4jConfigFromEnv } from "./graph/neo4j.js";
import { assembleSpans } from "./ner/assemble.js";
import { buildBoundaryQuestions } from "./ner/resolve.js";
import { buildTagQuestions, chunkState, decideTag, tagQuestionId } from "./ner/tag.js";
import { documentFromText, extractPdf } from "./pdf/extract.js";
import { DEFAULT_OPTIONS, type PipelineOptions, type PipelineResult, runPipeline } from "./pipeline.js";
import { DEFAULT_SCHEMA_PATH, loadSchema } from "./schema.js";
import { segment } from "./text/chunk.js";
import type { GraphData } from "./types.js";

const EXIT_STAGE_FAILED = 1;
const EXIT_BAD_INPUT = 2;

class BadInput extends Error {}

const log = (message: string) => process.stderr.write(`${message}\n`);

function probability(value: string): number {
  const p = Number(value);
  if (!(p >= 0 && p <= 1)) throw new InvalidArgumentError("expected a number between 0 and 1");
  return p;
}

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

interface CommonFlags {
  schema: string;
  out: string;
  model?: string;
  concurrency: number;
  chunkSize: number;
  resolve: boolean;
  accept: number;
  review: number;
  includeReview: boolean;
  cache: boolean;
  json: boolean;
}

function withCommon(command: Command): Command {
  return command
    .option("--schema <file>", "entity and relation schema", DEFAULT_SCHEMA_PATH)
    .option("--out <dir>", "parent directory for run artifacts", "out")
    .option("--model <id>", "Jev model id (default: TYPESAFE_DEFAULT_MODEL or jev-1.13.0)")
    .option("--concurrency <n>", "requests in flight", positiveInt, DEFAULT_OPTIONS.concurrency)
    .option("--chunk-size <n>", "askable tokens per chunk", positiveInt, DEFAULT_OPTIONS.chunkSize)
    .option("--no-resolve", "skip span resolution (stage 3c)")
    .option("--accept <p>", "confidence at or above which a mention or relation is accepted", probability, DEFAULT_OPTIONS.thresholds.accept)
    .option("--review <p>", "confidence below which a mention or relation is dropped; between the two it is kept for review", probability, DEFAULT_OPTIONS.thresholds.review)
    .option("--include-review", "keep review-band mentions and relations", false)
    .option("--no-cache", "call the API even when a cached answer exists")
    .option("--json", "print the result as JSON on stdout", false);
}

function pipelineOptions(flags: CommonFlags): PipelineOptions {
  return {
    ...DEFAULT_OPTIONS,
    schema: loadSchema(flags.schema),
    schemaPath: resolve(flags.schema),
    model: flags.model ?? jevModel(),
    chunkSize: flags.chunkSize,
    resolve: flags.resolve,
    thresholds: { ...DEFAULT_OPTIONS.thresholds, accept: flags.accept, review: Math.min(flags.review, flags.accept) },
    includeReview: flags.includeReview,
    concurrency: flags.concurrency,
    cacheDir: flags.cache ? ".cache/jev" : null,
    outDir: flags.out,
    log,
  };
}

function requirePdf(path: string): string {
  if (!existsSync(path)) throw new BadInput(`no such file: ${path}`);
  return path;
}

async function extract(pdf: string, flags: CommonFlags): Promise<PipelineResult> {
  const options = pipelineOptions(flags);
  const doc = await extractPdf(requirePdf(pdf));
  log(`${doc.title}: ${doc.pageCount} pages, ${doc.text.length} characters`);
  if (doc.skippedPages.length) log(`warning: pages ${doc.skippedPages.join(", ")} have almost no text (probably scanned) and were skipped`);
  if (!doc.text.trim()) throw new BadInput("the PDF has no extractable text; scanned PDFs need OCR, which v1 does not do");
  return runPipeline(doc, createTypeSafe(), options);
}

function summary(result: PipelineResult) {
  const stats = callStats(result.calls, loadPricing());
  return {
    runId: result.manifest.runId,
    runDir: result.runDir,
    counts: result.manifest.counts,
    wallSeconds: (result.manifest.wallMs ?? 0) / 1000,
    calls: stats.calls,
    cachedCalls: result.calls.filter((c) => c.cached).length,
    inputTokens: stats.inputTokens,
    costUsd: stats.cost,
  };
}

function printResult(result: PipelineResult, json: boolean): void {
  if (json) return void process.stdout.write(`${JSON.stringify({ ...summary(result), entities: result.entities, relations: result.relations }, null, 2)}\n`);
  const byId = new Map(result.entities.map((e) => [e.id, e]));
  const lines = [
    "",
    "Entities",
    ...result.entities.map((e) => `  ${e.type.padEnd(13)} ${e.canonicalName}${e.aliases.length ? `  (also: ${e.aliases.join(", ")})` : ""}  ${e.confidence.toFixed(2)}`),
    "",
    "Relations",
    ...result.relations.map(
      (r) => `  ${byId.get(r.sourceId)?.canonicalName} -[${r.type} ${r.confidence.toFixed(2)}${r.needsReview ? ", review" : ""}]-> ${byId.get(r.targetId)?.canonicalName}`,
    ),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  const s = summary(result);
  log(`${s.calls} API calls (${s.cachedCalls} more served from cache), ${s.inputTokens.toLocaleString("en-US")} input tokens, ${s.costUsd === null ? "cost n/a" : `$${s.costUsd.toFixed(5)}`}, ${s.wallSeconds.toFixed(1)} s. Artifacts: ${s.runDir}`);
}

async function load(graph: GraphData, flags: { cypher?: string; withMentions: boolean }): Promise<void> {
  if (flags.cypher) {
    await new CypherExportStore(flags.cypher).write(graph, { withMentions: flags.withMentions });
    log(`wrote ${flags.cypher}`);
    return;
  }
  const store = new Neo4jStore(neo4jConfigFromEnv());
  try {
    await store.write(graph, { withMentions: flags.withMentions });
    const counts = await store.counts();
    log(`graph loaded: ${graph.entities.length} entities and ${graph.relations.length} relations from this document; the database now holds ${counts.nodes} nodes and ${counts.relationships} relationships`);
  } finally {
    await store.close();
  }
}

const program = new Command("nerjev").description("PDF to knowledge graph: NER and relation extraction with TypeSafe Jev, judged by Claude");

withCommon(program.command("run <pdf>").description("PDF to graph: extract, then load into Neo4j (or a .cypher file)"))
  .option("--cypher <file>", "write a .cypher script instead of connecting to Neo4j")
  .option("--with-mentions", "also write Mention nodes", false)
  .action(async (pdf: string, flags: CommonFlags & { cypher?: string; withMentions: boolean }) => {
    const result = await extract(pdf, flags);
    printResult(result, flags.json);
    await load(result.graph, flags);
  });

withCommon(program.command("extract <pdf>").description("stages 1 to 5: writes JSON artifacts and touches no database")).action(
  async (pdf: string, flags: CommonFlags) => printResult(await extract(pdf, flags), flags.json),
);

program
  .command("load <runDir>")
  .description("load an existing run into the graph")
  .option("--cypher <file>", "write a .cypher script instead of connecting to Neo4j")
  .option("--with-mentions", "also write Mention nodes", false)
  .action(async (runDir: string, flags: { cypher?: string; withMentions: boolean }) => {
    const path = join(runDir, "graph.json");
    if (!existsSync(path)) throw new BadInput(`${path} not found; is this a run directory?`);
    await load(JSON.parse(readFileSync(path, "utf8")) as GraphData, flags);
  });

function makeJudge(runDir: string | null, context: { runId: string; variant: string; docId: string }, concurrency: number): Judge {
  return new Judge({
    client: createAnthropic(),
    model: judgeModel(),
    recorder: new Recorder(runDir ? join(runDir, "calls.jsonl") : null, context),
    limit: pLimit(concurrency),
  });
}

program
  .command("eval <runDir>")
  .description("grade a run with the Claude judge; writes judge.jsonl and accuracy.json")
  .option("--schema <file>", "schema the run was extracted with", DEFAULT_SCHEMA_PATH)
  .option("--sample-every <n>", "judge every n-th chunk only", positiveInt, 1)
  .option("--concurrency <n>", "judge requests in flight", positiveInt, 4)
  .action(async (runDir: string, flags: { schema: string; sampleEvery: number; concurrency: number }) => {
    if (!existsSync(join(runDir, "manifest.json"))) throw new BadInput(`${runDir} is not a run directory`);
    const { manifest } = loadRun(runDir);
    const judge = makeJudge(runDir, { runId: manifest.runId, variant: manifest.variant, docId: manifest.docId }, flags.concurrency);
    const accuracy = await evaluateRun(runDir, judge, loadSchema(flags.schema), { sampleEvery: flags.sampleEvery, log });
    process.stdout.write(`${JSON.stringify(accuracy, null, 2)}\n`);
    if (accuracy.judge.chunksFailed) process.exitCode = EXIT_STAGE_FAILED;
  });

withCommon(program.command("gold").description("score the extractor against the hand-labelled passages by exact match, with no judge involved"))
  .option("--gold <dir>", "gold passages", "bench/gold")
  .action(async (flags: CommonFlags & { gold: string }) => {
    const options = { ...pipelineOptions(flags), outDir: null, log: () => {} };
    const gold = loadGold(flags.gold, options.schema);
    if (!gold.length) throw new BadInput(`no gold passages in ${flags.gold}`);
    const client = createTypeSafe();
    const scores = [];
    for (const passage of gold) scores.push(scoreAgainstGold(passage, await runPipeline(documentFromText(passage.text, passage.id), client, options)));
    const total = sumScores(scores);
    if (flags.json) return void process.stdout.write(`${JSON.stringify(total, null, 2)}\n`);
    const line = (name: string, m: typeof total.entity) =>
      `${name.padEnd(10)} P ${((m.precision ?? 0) * 100).toFixed(1)}%  R ${((m.recall ?? 0) * 100).toFixed(1)}%  F1 ${((m.f1 ?? 0) * 100).toFixed(1)}%   (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`;
    process.stdout.write(`${gold.length} gold passages, exact match\n${line("entities", total.entity)}\n${line("relations", total.relation)}\n`);
    for (const e of total.errors) process.stdout.write(`  ${e.passage}  ${e.error.padEnd(14)} ${e.kind.padEnd(8)} ${e.item}\n`);
  });

program
  .command("judge-check")
  .description("calibrate the judge on the gold set: agreement with human labels, and known negatives that must fail")
  .option("--schema <file>", "schema", DEFAULT_SCHEMA_PATH)
  .option("--gold <dir>", "gold passages", "bench/gold")
  .option("--limit <n>", "use only the first n passages (each passage costs four judge calls)", positiveInt)
  .option("--concurrency <n>", "judge requests in flight", positiveInt, 4)
  .action(async (flags: { schema: string; gold: string; limit?: number; concurrency: number }) => {
    const schema = loadSchema(flags.schema);
    const gold = loadGold(flags.gold, schema).slice(0, flags.limit);
    if (!gold.length) throw new BadInput(`no gold passages in ${flags.gold}`);
    const judge = makeJudge(null, { runId: "judge-check", variant: "judge-check", docId: "gold" }, flags.concurrency);
    const check = await checkJudge(judge, schema, gold);
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    log(check.passed ? "judge check passed" : "judge check FAILED: do not rely on judge-based accuracy until it passes");
    if (!check.passed) process.exitCode = EXIT_STAGE_FAILED;
  });

program
  .command("bench")
  .description("run variants x documents x repetitions with the cache off, and write report.md and summary.csv")
  .option("--schema <file>", "schema", DEFAULT_SCHEMA_PATH)
  .option("--docs <dir>", "benchmark PDFs", "bench/docs")
  .option("--gold <dir>", "gold passages", "bench/gold")
  .option("--out <dir>", "output directory", "out")
  .option("--model <id>", "Jev model id; pin a version, not the jev-latest alias")
  .option("--variants <names>", `comma-separated subset of: ${VARIANTS.map((v) => v.name).join(", ")}`)
  .option("--reps <n>", "repetitions per variant and document", positiveInt, 3)
  .option("--concurrency <n>", "requests in flight", positiveInt, DEFAULT_OPTIONS.concurrency)
  .option("--judge", "also grade the first repetition of each run with the Claude judge (costs more than the extraction)", false)
  .option("--judge-sample-every <n>", "judge every n-th chunk only", positiveInt, 1)
  .action(async (flags: { schema: string; docs: string; gold: string; out: string; model?: string; variants?: string; reps: number; concurrency: number; judge: boolean; judgeSampleEvery: number }) => {
    const schema = loadSchema(flags.schema);
    const wanted = flags.variants?.split(",").map((name) => name.trim());
    const variants = wanted ? VARIANTS.filter((v) => wanted.includes(v.name)) : VARIANTS;
    if (!variants.length) throw new BadInput(`no such variant; choose from ${VARIANTS.map((v) => v.name).join(", ")}`);
    const model = flags.model ?? jevModel();
    if (/latest|preview/.test(model)) log(`warning: ${model} is an alias that moves; pin a versioned id for numbers you intend to compare`);
    const { reportPath, csvPath } = await runBenchmark(createTypeSafe(), {
      docsDir: flags.docs,
      gold: existsSync(flags.gold) ? loadGold(flags.gold, schema) : [],
      outDir: flags.out,
      variants,
      repetitions: flags.reps,
      concurrency: flags.concurrency,
      model,
      schema,
      schemaPath: resolve(flags.schema),
      pricing: loadPricing(),
      makeJudge: flags.judge ? (runDir, context) => makeJudge(runDir, context, 4) : null,
      judgeSampleEvery: flags.judgeSampleEvery,
      log,
    });
    log(`report: ${reportPath}\nsummary: ${csvPath}`);
  });

program
  .command("report <benchDir>")
  .description("rebuild report.md and summary.csv from a finished benchmark, with no API calls (use after editing bench/pricing.json)")
  .action((benchDir: string) => {
    if (!existsSync(join(benchDir, "runs"))) throw new BadInput(`${benchDir} is not a benchmark directory`);
    const { reportPath, csvPath } = rebuildReport(benchDir, loadPricing());
    log(`report: ${reportPath}\nsummary: ${csvPath}`);
  });

program
  .command("dashboard <benchDir>")
  .description("build a self-contained HTML dashboard from a finished benchmark, with no API calls")
  .option("--notes <file>", "JSON with a subtitle, document labels, findings and caveats to show")
  .option("--judge-check <file>", "output of `judge-check` to include")
  .option("--out <file>", "where to write the page (default: <benchDir>/dashboard.html)")
  .action((benchDir: string, flags: { notes?: string; judgeCheck?: string; out?: string }) => {
    if (!existsSync(join(benchDir, "runs"))) throw new BadInput(`${benchDir} is not a benchmark directory`);
    const readJson = <T>(path: string): T => {
      if (!existsSync(path)) throw new BadInput(`no such file: ${path}`);
      return JSON.parse(readFileSync(path, "utf8")) as T;
    };
    const notes: DashboardNotes = flags.notes ? readJson<DashboardNotes>(flags.notes) : { findings: [], caveats: [] };
    const judgeCheck = flags.judgeCheck ? readJson<JudgeCheck>(flags.judgeCheck) : null;
    const out = flags.out ?? join(benchDir, "dashboard.html");
    writeFileSync(out, renderDashboard(buildDashboardData(benchDir, loadPricing(), notes, judgeCheck)));
    log(`dashboard: ${out}`);
  });

program
  .command("inspect <pdf>")
  .description("print the exact Jev request for one chunk, ready to paste into the TypeSafe Playground")
  .option("--schema <file>", "schema", DEFAULT_SCHEMA_PATH)
  .option("--chunk <n>", "chunk index", (v) => Number.parseInt(v, 10), 0)
  .option("--chunk-size <n>", "askable tokens per chunk", positiveInt, DEFAULT_OPTIONS.chunkSize)
  .option("--stage <stage>", "tag or resolve; resolve needs the tag answers, so it calls the API once", "tag")
  .option("--out <file>", "write to a file instead of stdout")
  .action(async (pdf: string, flags: { schema: string; chunk: number; chunkSize: number; stage: string; out?: string }) => {
    const schema = loadSchema(flags.schema);
    const doc = await extractPdf(requirePdf(pdf));
    const { tokens, chunks } = segment(doc, flags.chunkSize);
    const chunk = chunks[flags.chunk];
    if (!chunk) throw new BadInput(`chunk ${flags.chunk} does not exist; the document has ${chunks.length} chunks`);
    let questions = buildTagQuestions(doc.text, tokens, chunk, schema);
    if (flags.stage === "resolve") {
      const answers = await createTypeSafe().systemOne({ state: chunkState(chunk), questions, model: jevModel() });
      const tags = tokens
        .slice(chunk.tokenStart, chunk.tokenEnd)
        .filter((t) => answers.answers[tagQuestionId(t.index)])
        .map((t) => decideTag(t.index, { ...answers.answers[tagQuestionId(t.index)]!.probabilities }, DEFAULT_OPTIONS.thresholds.token));
      questions = buildBoundaryQuestions(doc.text, tokens, chunk, assembleSpans(doc.text, tokens, chunk, tags), schema).questions;
    } else if (flags.stage !== "tag") throw new BadInput("--stage must be tag or resolve");
    const request = JSON.stringify({ state: chunkState(chunk), model: jevModel(), questions }, null, 2);
    if (flags.out) writeFileSync(flags.out, request);
    else process.stdout.write(`${request}\n`);
    log(`chunk ${chunk.id}: ${Object.keys(questions).length} questions. Playground: https://console.typesafe.ai/playground`);
  });

loadEnv();
program.parseAsync().catch((error: unknown) => {
  const badInput = error instanceof BadInput || error instanceof MissingKeyError;
  log(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = badInput ? EXIT_BAD_INPUT : EXIT_STAGE_FAILED;
});
