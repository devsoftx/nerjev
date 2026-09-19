# nerjev benchmark report

Generated 2026-09-19T18:36:18.349Z. Models seen in responses: claude-opus-5, jev-1.13.0. Prices as of 2026-09-19.
Every figure comes from recorded API responses. Cost is computed here from recorded tokens and `bench/pricing.json`, so a price change means re-running the report and not the benchmark. Cached calls are excluded. Pipeline cost never includes judge cost.


## Overview

One row per variant and document, averaged over repetitions. Wall time shows the mean with its range.

| variant | doc | reps | calls | input tokens | wall s | pages/min | cost | cost/page | payload KiB | entity F1 (judge, strict) | entity F1 (gold) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tag-only-80 | 2b2a1f91 | 3 | 11.0 | 166,417 | 1.1 (0.8–1.6) | 160.6 | $0.006990 | $0.002330 | 591.1 | 100.0% | 98.2% |
| resolve-40 | 2b2a1f91 | 3 | 41.0 | 241,055 | 2.0 (2.0–2.0) | 89.2 | $0.0101 | $0.003375 | 844.3 | 98.5% | 100.0% |
| resolve-80 | 2b2a1f91 | 3 | 21.0 | 236,158 | 1.4 (1.4–1.4) | 128.6 | $0.009919 | $0.003306 | 843.4 | 98.5% | 100.0% |
| resolve-160 | 2b2a1f91 | 3 | 15.3 | 235,905 | 1.5 (1.5–1.6) | 118.3 | $0.009908 | $0.003303 | 847.5 | 100.0% | 100.0% |

## Per stage

Latency is the final successful attempt of each call, in milliseconds, and excludes time queued behind the local concurrency limit. Per-run figures divide by the runs in which the stage ran; the judge grades the first repetition only. The last column counts calls that retried, that met a 429 or 529, and that failed.

| variant | doc | stage | calls/run | input tokens/call min / med / max | output tokens/run | p50 ms | p95 ms | questions/req | req KiB/call | resp KiB/call | bytes/input token | cost/call (median) | cost/run | retried / limited / failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tag-only-80 | 2b2a1f91 | ner_tag | 5.0 | 13,643 / 34,818 / 37,249 | 22,095 | 447 | 903 | 75 | 100.4 | 11.5 | 3.28 | $0.001462 | $0.006574 | 0 / 0 / 0 |
| tag-only-80 | 2b2a1f91 | entity_align | 1.0 | 467 / 467 / 467 | 17 | 191 | 226 | 1 | 0.7 | 0.4 | 1.54 | $0.000020 | $0.000020 | 0 / 0 / 0 |
| tag-only-80 | 2b2a1f91 | relation | 5.0 | 1,102 / 1,656 / 2,808 | 2,073 | 196 | 242 | 8 | 4.9 | 1.3 | 2.64 | $0.000070 | $0.000396 | 0 / 0 / 0 |
| tag-only-80 | 2b2a1f91 | judge | 7.0 | 677 / 3,612 / 3,968 | 8,289 | 12,523 | 16,717 | n/a | 7.6 | 4.1 | 2.52 | $0.0529 | $0.3159 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | ner_tag | 10.0 | 11,732 / 16,258 / 18,716 | 22,110 | 291 | 382 | 35 | 50.1 | 5.8 | 3.26 | $0.000683 | $0.006615 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | ner_resolve | 10.0 | 2,848 / 3,972 / 5,797 | 6,850 | 221 | 362 | 7 | 12.5 | 1.8 | 3.23 | $0.000167 | $0.001671 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | ner_type | 10.0 | 2,449 / 3,133 / 4,670 | 4,497 | 208 | 332 | 7 | 9.6 | 1.3 | 3.03 | $0.000132 | $0.001365 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | entity_align | 1.0 | 467 / 467 / 467 | 17 | 217 | 262 | 1 | 0.7 | 0.4 | 1.54 | $0.000020 | $0.000020 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | relation | 10.0 | 755 / 1,030 / 1,940 | 2,075 | 201 | 261 | 4 | 2.5 | 0.7 | 2.35 | $0.000043 | $0.000454 | 0 / 0 / 0 |
| resolve-40 | 2b2a1f91 | judge | 12.0 | 677 / 2,852 / 3,135 | 7,136 | 6,365 | 9,762 | n/a | 6.6 | 2.5 | 2.54 | $0.0291 | $0.3388 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | ner_tag | 5.0 | 13,643 / 34,818 / 37,249 | 22,095 | 404 | 445 | 75 | 100.4 | 11.5 | 3.28 | $0.001462 | $0.006574 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | ner_resolve | 5.0 | 3,478 / 9,481 / 10,438 | 6,938 | 216 | 313 | 17 | 25.4 | 3.6 | 3.34 | $0.000398 | $0.001636 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | ner_type | 5.0 | 2,925 / 7,738 / 8,183 | 4,459 | 241 | 362 | 17 | 19.0 | 2.5 | 3.15 | $0.000325 | $0.001297 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | entity_align | 1.0 | 467 / 467 / 467 | 17 | 152 | 176 | 1 | 0.7 | 0.4 | 1.54 | $0.000020 | $0.000020 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | relation | 5.0 | 1,102 / 1,658 / 2,808 | 2,045 | 189 | 251 | 8 | 4.8 | 1.2 | 2.64 | $0.000070 | $0.000391 | 0 / 0 / 0 |
| resolve-80 | 2b2a1f91 | judge | 7.0 | 677 / 3,612 / 3,968 | 8,424 | 11,076 | 20,294 | n/a | 7.6 | 4.2 | 2.52 | $0.0505 | $0.3191 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | ner_tag | 5.0 | 12,699 / 36,047 / 37,397 | 22,095 | 439 | 513 | 77 | 100.9 | 11.5 | 3.28 | $0.001514 | $0.006603 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | ner_resolve | 3.0 | 3,453 / 15,793 / 19,170 | 6,964 | 254 | 309 | 29 | 42.5 | 6.0 | 3.38 | $0.000663 | $0.001621 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | ner_type | 3.0 | 2,900 / 12,656 / 15,226 | 4,518 | 257 | 310 | 28 | 32.0 | 4.1 | 3.20 | $0.000532 | $0.001287 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | entity_align | 1.3 | 462 / 467 / 467 | 23 | 186 | 222 | 1 | 0.7 | 0.4 | 1.53 | $0.000020 | $0.000026 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | relation | 3.0 | 1,081 / 3,580 / 4,188 | 2,076 | 214 | 251 | 19 | 8.0 | 2.0 | 2.79 | $0.000150 | $0.000372 | 0 / 0 / 0 |
| resolve-160 | 2b2a1f91 | judge | 5.0 | 677 / 4,522 / 5,393 | 8,854 | 23,000 | 26,907 | n/a | 9.2 | 5.7 | 2.50 | $0.0903 | $0.3156 | 0 / 0 / 0 |

## Accuracy

Judge columns come from the LLM judge; recall and F1 there are estimates because the list of misses is the judge's. Gold columns are exact match against the hand-labelled passages, with no judge involved. Judge self-agreement is the judge's noise floor: a difference between two variants that is smaller than (100% − self-agreement) should not be read as a difference. The tp / fp / fn columns give the counts behind each percentage: with a few dozen items, one item moves a score by a point or more, so compare counts before comparing percentages.

| variant | doc | ent P | ent R | ent F1 | ent tp / fp / fn | ent P (relaxed) | ent R (relaxed) | ent F1 (relaxed) | rel P | rel R | rel F1 | rel tp / fp / fn | type acc | cluster purity | ECE | judge self-agreement | gold ent P | gold ent R | gold ent F1 | gold ent tp / fp / fn | gold rel P | gold rel R | gold rel F1 | gold rel tp / fp / fn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tag-only-80 | 2b2a1f91 | 100.0% | 100.0% | 100.0% | 67 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 | 100.0% | 100.0% | 0.021 | 100.0% | 98.2% | 98.2% | 98.2% | 54 / 1 / 1 | 97.1% | 87.2% | 91.9% | 34 / 1 / 5 |
| resolve-40 | 2b2a1f91 | 98.5% | 98.5% | 98.5% | 66 / 1 / 1 | 100.0% | 100.0% | 100.0% | 100.0% | 94.6% | 97.2% | 35 / 0 / 2 | 100.0% | 100.0% | 0.013 | 100.0% | 100.0% | 100.0% | 100.0% | 55 / 0 / 0 | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 |
| resolve-80 | 2b2a1f91 | 98.5% | 98.5% | 98.5% | 66 / 1 / 1 | 100.0% | 100.0% | 100.0% | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 | 100.0% | 100.0% | 0.012 | 100.0% | 100.0% | 100.0% | 100.0% | 55 / 0 / 0 | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 |
| resolve-160 | 2b2a1f91 | 100.0% | 100.0% | 100.0% | 67 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 | 100.0% | 100.0% | 0.000 | 100.0% | 100.0% | 100.0% | 100.0% | 55 / 0 / 0 | 100.0% | 89.7% | 94.6% | 35 / 0 / 4 |

Gold set: 12 passages.

## Yield and unit cost

First repetition of each variant and document.

| variant | doc | mentions | entities | relations | relations in graph | entities/page | relations/page | cost/entity | cost/relation | judge cost (separate) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tag-only-80 | 2b2a1f91 | 69 | 54 | 36 | 35 | 18.0 | 11.7 | $0.000129 | $0.000200 | $0.3159 |
| resolve-40 | 2b2a1f91 | 67 | 54 | 35 | 35 | 18.0 | 11.7 | $0.000187 | $0.000288 | $0.3388 |
| resolve-80 | 2b2a1f91 | 67 | 54 | 36 | 35 | 18.0 | 11.7 | $0.000184 | $0.000283 | $0.3191 |
| resolve-160 | 2b2a1f91 | 67 | 54 | 35 | 35 | 18.0 | 11.7 | $0.000184 | $0.000283 | $0.3156 |
