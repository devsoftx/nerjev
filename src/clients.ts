import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Effort } from "./answerer.js";
import { type FetchLike, instrumentedFetch } from "./telemetry/instrumentedFetch.js";

/** An 80-question request can take longer than the SDK's 10 s default. */
const TYPESAFE_TIMEOUT_MS = 60_000;

export class MissingKeyError extends Error {}

/** Reads .env from the working directory. Variables already set in the environment win. */
export function loadEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function createTypeSafe(baseFetch?: FetchLike): TypeSafeClient {
  if (!process.env.TYPESAFE_API_KEY?.trim() && !baseFetch) {
    throw new MissingKeyError("TYPESAFE_API_KEY is not set. Add it to .env (see .env.example).");
  }
  return new TypeSafeClient({
    apiKey: process.env.TYPESAFE_API_KEY?.trim() || "fake-key",
    fetch: instrumentedFetch(baseFetch),
    timeout: TYPESAFE_TIMEOUT_MS,
    // The pacer keeps us under the rate limit; these retries cover the bursts it cannot see.
    retry: { maxRetries: 6, backoffInitialMs: 1000, backoffMaxMs: 15_000 },
    logLevel: "error",
  });
}

export function createAnthropic(baseFetch?: FetchLike): Anthropic {
  // With no key, the SDK still resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  return new Anthropic({
    ...(baseFetch ? { apiKey: "fake-key" } : {}),
    fetch: instrumentedFetch(baseFetch),
    maxRetries: 6,
  });
}

export const jevModel = () => process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0";
export const judgeModel = () => process.env.JUDGE_MODEL?.trim() || "claude-fable-5-1";
/** The LLM that can stand in for Jev (--answerer claude, and the opus-* benchmark variants). */
export const llmAnswererModel = () => process.env.ANSWERER_MODEL?.trim() || "claude-opus-5";
/** Low is the production-like setting for high-volume classification; raise it to buy accuracy with tokens. */
export const llmAnswererEffort = () => (process.env.ANSWERER_EFFORT?.trim() || "low") as Effort;
