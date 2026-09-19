import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CallTrace } from "../telemetry/instrumentedFetch.js";
import type { CallRecord, Stage } from "../types.js";

export interface RunContext {
  runId: string;
  variant: string;
  docId: string;
}

export interface CallMeta {
  stage: Stage;
  chunkId: string | null;
}

export interface CallOutcome {
  provider: CallRecord["provider"];
  model: string;
  trace: CallTrace;
  wallMs: number;
  usage: Pick<CallRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;
  questionCount: number | null;
  stateChars: number | null;
  cached: boolean;
  error: string | null;
}

/** Appends one row per API call to calls.jsonl. Synchronous appends keep rows whole under concurrency. */
export class Recorder {
  readonly rows: CallRecord[] = [];

  constructor(
    private readonly path: string | null,
    readonly context: RunContext,
  ) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  record(meta: CallMeta, outcome: CallOutcome): CallRecord {
    const attempts = outcome.trace.attempts;
    const last = attempts[attempts.length - 1];
    const succeeded = last && last.status !== null && last.status >= 200 && last.status < 300;
    const row: CallRecord = {
      ...this.context,
      chunkId: meta.chunkId,
      stage: meta.stage,
      provider: outcome.provider,
      model: outcome.model,
      requestId: last?.requestId ?? null,
      startedAt: new Date(attempts[0]?.startedAt ?? Date.now()).toISOString(),
      latencyMs: succeeded ? round(last.durationMs) : null,
      wallMs: round(outcome.wallMs),
      attempts: attempts.length,
      statusCodes: attempts.map((a) => a.status ?? 0),
      requestBytes: last?.requestBytes ?? null,
      responseBytes: last?.responseBytes ?? null,
      ...outcome.usage,
      questionCount: outcome.questionCount,
      stateChars: outcome.stateChars,
      cached: outcome.cached,
      error: outcome.error,
    };
    this.rows.push(row);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    return row;
  }
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function readCalls(path: string): CallRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CallRecord);
}
