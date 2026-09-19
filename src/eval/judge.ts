import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LimitFunction } from "p-limit";
import type { z } from "zod";
import type { CallMeta, Recorder } from "../bench/recorder.js";
import type { ExtractionSchema } from "../schema.js";
import { traceCall } from "../telemetry/instrumentedFetch.js";
import {
  ChunkVerdicts,
  chunkSystemPrompt,
  chunkUserPrompt,
  ClusterVerdicts,
  clusterSystemPrompt,
  type JudgedMention,
  type JudgedRelation,
} from "./rubric.js";

const MAX_TOKENS = 16_000;

export interface JudgeOptions {
  client: Anthropic;
  model: string;
  recorder: Recorder;
  limit: LimitFunction;
}

export type JudgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The Claude judge. Server-side model fallbacks are deliberately not enabled: a verdict must come
 * from the model named in the report, so a refusal or a truncated answer is returned as an error
 * for the caller to count, never silently answered by a different model.
 */
export class Judge {
  constructor(private readonly options: JudgeOptions) {}

  get model(): string {
    return this.options.model;
  }

  private async call<S extends z.ZodType>(schema: S, system: string, user: string, meta: CallMeta): Promise<JudgeResult<z.infer<S>>> {
    const { client, model, recorder, limit } = this.options;
    const { trace, wallMs, outcome } = await limit(() =>
      traceCall(() =>
        client.messages.parse({
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "high", format: zodOutputFormat(schema) },
          system,
          messages: [{ role: "user", content: user }],
        }),
      ),
    );

    const message = outcome.ok ? outcome.value : null;
    let error: string | null = null;
    if (!outcome.ok) error = describe(outcome.error);
    else if (message!.stop_reason === "refusal") error = "judge_error: refusal";
    else if (message!.stop_reason === "max_tokens") error = "judge_error: truncated at max_tokens";
    else if (message!.parsed_output == null) error = "judge_error: output did not match the schema";

    recorder.record(meta, {
      provider: "anthropic",
      model: message?.model ?? model,
      trace,
      wallMs,
      usage: {
        inputTokens: message?.usage.input_tokens ?? null,
        outputTokens: message?.usage.output_tokens ?? null,
        cacheReadTokens: message?.usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: message?.usage.cache_creation_input_tokens ?? null,
      },
      questionCount: null,
      stateChars: user.length,
      cached: false,
      error,
    });
    return error ? { ok: false, error } : { ok: true, value: message!.parsed_output as z.infer<S> };
  }

  judgeChunk(
    schema: ExtractionSchema,
    chunkId: string,
    text: string,
    mentions: JudgedMention[],
    relations: JudgedRelation[],
  ): Promise<JudgeResult<ChunkVerdicts>> {
    return this.call(ChunkVerdicts, chunkSystemPrompt(schema), chunkUserPrompt(text, mentions, relations), { stage: "judge", chunkId });
  }

  judgeClusters(clusters: { id: string; type: string; names: string[]; contexts: string[] }[]): Promise<JudgeResult<ClusterVerdicts>> {
    return this.call(ClusterVerdicts, clusterSystemPrompt(), `<clusters>\n${JSON.stringify(clusters, null, 1)}\n</clusters>`, {
      stage: "judge",
      chunkId: null,
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "AuthenticationError: check ANTHROPIC_API_KEY";
  if (error instanceof Anthropic.RateLimitError) return `RateLimitError: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `APIError ${error.status}: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
