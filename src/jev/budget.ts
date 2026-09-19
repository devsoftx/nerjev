import type { Stage } from "../types.js";

/** Jev allows 64k tokens per request for state plus all questions; stay well inside it. */
const TARGET_TOKENS = 48_000;
const INITIAL_QUESTIONS = 80;
const MIN_QUESTIONS = 10;
/** Keep individual requests a manageable size even when the token budget would allow more. */
const MAX_QUESTIONS = 200;

/**
 * Sizes question batches from the input_tokens the API actually reports. There are no string-length
 * token estimates: until a stage has been observed once, the batch size is the spec's starting value.
 */
export class Budget {
  private readonly tokensPerQuestion = new Map<Stage, number>();

  maxQuestions(stage: Stage): number {
    const ratio = this.tokensPerQuestion.get(stage);
    if (!ratio) return INITIAL_QUESTIONS;
    return Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, Math.floor(TARGET_TOKENS / ratio)));
  }

  /** The ratio folds the state's tokens into each question, which errs on the safe side. */
  observe(stage: Stage, inputTokens: number, questionCount: number): void {
    if (!inputTokens || !questionCount) return;
    const ratio = inputTokens / questionCount;
    this.tokensPerQuestion.set(stage, Math.max(ratio, this.tokensPerQuestion.get(stage) ?? 0));
  }
}
