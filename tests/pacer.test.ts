import { describe, expect, it } from "vitest";
import { Budget } from "../src/jev/budget.js";
import { TokenPacer } from "../src/jev/pacer.js";

describe("TokenPacer", () => {
  it("spaces request starts so tokens per second stay under the limit", async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = new TokenPacer(200_000, () => clock, async (ms) => { waits.push(ms); clock += ms; });
    // three 50k-token requests at once: the first starts now, the others a quarter second apart
    expect(await pacer.reserve(50_000)).toBe(0);
    expect(await pacer.reserve(50_000)).toBe(250);
    expect(await pacer.reserve(50_000)).toBe(250);
    expect(clock).toBe(500);
    // after an idle stretch nothing is owed
    clock = 10_000;
    expect(await pacer.reserve(50_000)).toBe(0);
  });

  it("estimates cautiously before a stage has been seen, then from what it cost", () => {
    const budget = new Budget();
    expect(budget.estimateTokens("ner_tag", 40)).toBe(28_000);
    budget.observe("ner_tag", 20_000, 40);
    expect(budget.estimateTokens("ner_tag", 80)).toBe(40_000);
    expect(budget.maxQuestions("ner_tag")).toBe(96);
  });
});
