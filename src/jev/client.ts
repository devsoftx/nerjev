import type { EntryType, Questions, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import type { LimitFunction } from "p-limit";
import type { CallMeta, Recorder } from "../bench/recorder.js";
import { traceCall } from "../telemetry/instrumentedFetch.js";
import { Budget } from "./budget.js";
import type { JevCache } from "./cache.js";
import type { TokenPacer } from "./pacer.js";

export interface JevOptions {
  client: TypeSafeClient;
  /** Pinned model id. Anything compared across runs should not use the jev-latest alias. */
  model: string;
  recorder: Recorder;
  limit: LimitFunction;
  cache?: JevCache | null;
  budget?: Budget;
  /** Shared across runs so that back-to-back runs respect the same tokens-per-second limit. */
  pacer?: TokenPacer | null;
}

type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

/**
 * The one place that talks to Jev. It splits a question set into budget-sized requests that share a
 * state, applies the concurrency limit, consults the cache, and records every call.
 */
export class Jev {
  readonly model: string;
  private readonly budget: Budget;

  constructor(private readonly options: JevOptions) {
    this.model = options.model;
    this.budget = options.budget ?? new Budget();
  }

  async ask<Q extends Questions>(state: EntryType, questions: Q, meta: CallMeta): Promise<Answers<Q>> {
    const names = Object.keys(questions);
    if (names.length === 0) return {} as Answers<Q>;

    const size = this.budget.maxQuestions(meta.stage);
    const batches: Questions[] = [];
    for (let i = 0; i < names.length; i += size) {
      batches.push(Object.fromEntries(names.slice(i, i + size).map((name) => [name, questions[name]!])));
    }
    const parts = await Promise.all(batches.map((batch) => this.request(state, batch, meta)));
    return Object.assign({}, ...parts) as Answers<Q>;
  }

  private async request(state: EntryType, questions: Questions, meta: CallMeta): Promise<Record<string, unknown>> {
    const { recorder, cache, client, limit } = this.options;
    const questionCount = Object.keys(questions).length;
    const stateChars = (typeof state === "string" ? state : JSON.stringify(state)).length;

    const hit = cache?.get(this.model, state, questions);
    if (hit) {
      recorder.record(meta, {
        provider: "typesafe",
        model: hit.model,
        trace: { attempts: [] },
        wallMs: 0,
        usage: { inputTokens: hit.usage.input_tokens, outputTokens: hit.usage.output_tokens, cacheReadTokens: null, cacheWriteTokens: null },
        questionCount,
        stateChars,
        cached: true,
        error: null,
      });
      return hit.answers;
    }

    // Waiting for the pacer and for a concurrency slot is local queueing, so the timer starts after both.
    await this.options.pacer?.reserve(this.budget.estimateTokens(meta.stage, questionCount));
    const { trace, wallMs, outcome } = await limit(() =>
      traceCall(() => client.systemOne({ state, questions, model: this.model })),
    );
    const result = outcome.ok ? outcome.value : null;
    recorder.record(meta, {
      provider: "typesafe",
      model: result?.model ?? this.model,
      trace,
      wallMs,
      usage: {
        inputTokens: result?.usage.input_tokens ?? null,
        outputTokens: result?.usage.output_tokens ?? null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      questionCount,
      stateChars,
      cached: false,
      error: outcome.ok ? null : describe(outcome.error),
    });
    if (!outcome.ok) throw outcome.error;

    const { model, answers, usage } = outcome.value;
    this.budget.observe(meta.stage, usage.input_tokens, questionCount);
    cache?.set(this.model, state, questions, { model, answers, usage });
    return answers;
  }
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
