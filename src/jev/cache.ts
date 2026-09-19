import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CachedAnswer {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Disk cache of Jev responses keyed by model, state and questions. Benchmarks never use it. */
export class JevCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(model: string, state: unknown, questions: unknown): string {
    const key = createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
    return join(this.dir, `${key}.json`);
  }

  get(model: string, state: unknown, questions: unknown): CachedAnswer | null {
    const path = this.pathFor(model, state, questions);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CachedAnswer) : null;
  }

  set(model: string, state: unknown, questions: unknown, value: CachedAnswer): void {
    writeFileSync(this.pathFor(model, state, questions), JSON.stringify(value));
  }
}
