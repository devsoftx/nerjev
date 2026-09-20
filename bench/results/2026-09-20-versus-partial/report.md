# nerjev benchmark report

Generated 2026-09-20T00:27:48.952Z. Models seen in responses: claude-fable-5-1, jev-1.13.0. Prices as of 2026-09-19.
Every figure comes from recorded API responses. Cost is computed here from recorded tokens and `bench/pricing.json`, so a price change means re-running the report and not the benchmark. Cached calls are excluded. Pipeline cost never includes judge cost.


## Overview

One row per variant and document, averaged over repetitions. Wall time shows the mean with its range.

| variant | doc | reps | calls | input tokens | wall s | pages/min | cost | cost/page | payload KiB | entity F1 (judge, strict) | entity F1 (gold) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean-80 | 66d96fc5 | 3 | 184.3 | 1,317,919 | 10.8 (10.7–11.0) | 83.0 | $0.0554 | $0.003690 | 5,128.6 | 76.6% | 99.2% |

## Per stage

Latency is the final successful attempt of each call, in milliseconds, and excludes time queued behind the local concurrency limit. Per-run figures divide by the runs in which the stage ran; the judge grades the first repetition only. The last column counts calls that retried, that met a 429 or 529, and that failed.

| variant | doc | stage | calls/run | input tokens/call min / med / max | output tokens/run | p50 ms | p95 ms | questions/req | req KiB/call | resp KiB/call | bytes/input token | cost/call (median) | cost/run | retried / limited / failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean-80 | 66d96fc5 | ner_tag | 57.0 | 2,719 / 16,812 / 20,144 | 404,929 | 335 | 481 | 68 | 46.7 | 16.5 | 3.02 | $0.000706 | $0.0380 | 0 / 0 / 0 |
| lean-80 | 66d96fc5 | ner_resolve | 56.0 | 1,395 / 4,294 / 5,702 | 78,753 | 214 | 314 | 12 | 11.7 | 3.3 | 3.01 | $0.000180 | $0.009321 | 0 / 0 / 0 |
| lean-80 | 66d96fc5 | ner_type | 56.0 | 1,328 / 3,360 / 4,559 | 58,744 | 219 | 355 | 10 | 9.0 | 2.6 | 2.88 | $0.000141 | $0.007484 | 0 / 0 / 0 |
| lean-80 | 66d96fc5 | entity_align | 5.0 | 613 / 682 / 860 | 85 | 189 | 233 | 1 | 1.6 | 0.4 | 2.28 | $0.000029 | $0.000149 | 0 / 0 / 0 |
| lean-80 | 66d96fc5 | relation | 10.3 | 570 / 822 / 2,270 | 1,002 | 179 | 234 | 1 | 2.5 | 0.3 | 2.51 | $0.000035 | $0.000446 | 0 / 0 / 0 |
| lean-80 | 66d96fc5 | judge | 22.0 | 3,001 / 3,405 / 3,601 | 23,092 | 14,331 | 22,462 | n/a | 8.5 | 4.4 | 3.01 | $0.0959 | n/a | 0 / 0 / 3 |

## Accuracy

Judge columns come from the LLM judge; recall and F1 there are estimates because the list of misses is the judge's. Gold columns are exact match against the hand-labelled passages, with no judge involved. Judge self-agreement is the judge's noise floor: a difference between two variants that is smaller than (100% − self-agreement) should not be read as a difference. The tp / fp / fn columns give the counts behind each percentage: with a few dozen items, one item moves a score by a point or more, so compare counts before comparing percentages.

| variant | doc | ent P | ent R | ent F1 | ent tp / fp / fn | ent P (relaxed) | ent R (relaxed) | ent F1 (relaxed) | rel P | rel R | rel F1 | rel tp / fp / fn | type acc | cluster purity | ECE | judge self-agreement | gold ent P | gold ent R | gold ent F1 | gold ent tp / fp / fn | gold rel P | gold rel R | gold rel F1 | gold rel tp / fp / fn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean-80 | 66d96fc5 | 76.1% | 77.2% | 76.6% | 105 / 33 / 31 | 88.4% | 89.7% | 89.1% | n/a | n/a | n/a | 0 / 0 / 0 | 99.2% | n/a | 0.229 | n/a | 100.0% | 98.5% | 99.2% | 66 / 0 / 1 | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 |

Gold set: 13 passages.

## Yield and unit cost

First repetition of each variant and document.

| variant | doc | mentions | entities | relations | relations in graph | entities/page | relations/page | cost/entity | cost/relation | judge cost (separate) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean-80 | 66d96fc5 | 493 | 181 | 0 | 0 | 12.1 | 0.0 | $0.000305 | n/a | n/a |
