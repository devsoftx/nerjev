/**
 * Spaces request starts so the input tokens sent per second stay under the provider's limit. Jev
 * allows 250k tokens per second; six 50k-token requests started together are past it, and the
 * answer is a 429. Each request reserves its share of the second, and the next one waits its turn.
 */
export class TokenPacer {
  private nextStart = 0;

  constructor(
    private readonly tokensPerSecond: number,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Resolves when a request of `tokens` may start. Returns how long it waited, in milliseconds. */
  async reserve(tokens: number): Promise<number> {
    const start = Math.max(this.now(), this.nextStart);
    this.nextStart = start + (tokens / this.tokensPerSecond) * 1000;
    const wait = start - this.now();
    if (wait > 0) await this.sleep(wait);
    return Math.max(0, wait);
  }
}

/** 80% of Jev's published 250k tokens per second, overridable for accounts with a different limit. */
export const DEFAULT_TOKENS_PER_SECOND = 200_000;

export function tokensPerSecondFromEnv(): number {
  const value = Number(process.env.TYPESAFE_TOKENS_PER_SECOND);
  return value > 0 ? value : DEFAULT_TOKENS_PER_SECOND;
}
