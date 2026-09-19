import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CallRecord } from "../types.js";

const PriceTable = z.object({
  asOf: z.string(),
  note: z.string().optional(),
  models: z.record(
    z.string(),
    z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }),
  ),
});
export type PriceTable = z.infer<typeof PriceTable>;

export const DEFAULT_PRICING_PATH = fileURLToPath(new URL("../../bench/pricing.json", import.meta.url));

export function loadPricing(path: string = DEFAULT_PRICING_PATH): PriceTable {
  return PriceTable.parse(JSON.parse(readFileSync(path, "utf8")));
}

function priceFor(table: PriceTable, model: string) {
  if (table.models[model]) return table.models[model];
  // A response may report a longer id than the table's key, e.g. a dated snapshot of the same model.
  const key = Object.keys(table.models)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table.models[key] : undefined;
}

/**
 * Cost in USD, computed at report time from the tokens a call recorded and the model its response
 * reported. Null when the model has no price, so a gap shows up as a gap and not as zero.
 */
export function costOf(table: PriceTable, call: Pick<CallRecord, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cached">): number | null {
  if (call.cached) return 0;
  const price = priceFor(table, call.model);
  if (!price || call.inputTokens === null) return null;
  const perToken = (rate: number | undefined, tokens: number | null) => ((rate ?? price.input) * (tokens ?? 0)) / 1_000_000;
  return (
    perToken(price.input, call.inputTokens) +
    perToken(price.output, call.outputTokens) +
    perToken(price.cacheRead, call.cacheReadTokens) +
    perToken(price.cacheWrite, call.cacheWriteTokens)
  );
}
