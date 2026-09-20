# nerjev — spec v1

Status: implemented on 2026-09-19; this document was updated to match what was built, and the
places where live testing changed the design say so · Owner: F. Rojas

First results and how to run everything: [README.md](README.md).

A TypeScript console app that reads a PDF, extracts named entities and the
relationships between them using TypeSafe's Jev model, and writes the result to a
graph database. A Claude-based LLM judge grades the output, and a benchmark harness
records what each call costs in tokens, time, money and bytes.

All implementation is TypeScript. No Python, no shell pipelines doing real work.

## 1. Goals and non-goals

Goals for v1:

1. `nerjev run file.pdf` takes a text PDF from disk to a populated graph in one command.
2. NER and relation extraction are done with Jev through `@typesafe-ai/sdk`, with
   entity and relation types defined in a schema file, not in code.
3. Every extracted value is a verbatim span of the source text with page and character
   offsets, and every graph edge carries the sentence that supports it.
4. An LLM judge (Claude, through `@anthropic-ai/sdk`) scores extraction accuracy, and a
   small hand-labelled gold set keeps the judge honest.
5. A benchmark reports token usage, speed, accuracy, cost per call and payload size per
   pipeline variant, from recorded data and not from estimates.

Not in v1: scanned PDFs and OCR, tables and figures, pronoun or nominal coreference
("the company", "she"), fuzzy entity matching across documents, any UI, and any accuracy
guarantee for non-English text (Jev is English-first; see open question 3).

## 2. The constraint that shapes the design

Jev does not generate text. It answers three kinds of typed question about a `state`:
Choice (one option from a set, with a probability per option), Noul (probability of yes)
and Score (position on ordered levels). So "list the entities in this text" is not a
request Jev can serve. Code has to propose candidates and Jev has to judge them.

TypeSafe's own value-extraction cookbook says candidates for names "have to come from a
roster you already have, or from a named-entity recognizer or an LLM that proposes
them". This project makes Jev the recognizer by asking one small question per token and
then one per candidate span. The same select-don't-generate pattern carries through
entity resolution and relation extraction.

Facts about `jev-1.13.0` that the design depends on (docs.typesafe.ai, read 2026-09-19):

| Fact | Consequence here |
| --- | --- |
| 64k tokens per request for state plus all questions; 32k for state plus the longest question | Chunk the document; cap questions per request |
| A Choice takes at most 255 options | Candidate lists stay small; never one option per token of a page |
| All questions in a request are answered in parallel and cannot see each other | Batch every independent question about a chunk into one call; a second call only when the first one's answers build the next candidates |
| Accuracy drops as state fills with unrelated text | Chunks are a few sentences, not a page |
| Reads instructions literally; weak at indirection, counting and arithmetic | Quote the target word in the question; count and compare in code |
| Priced at $0.042 per million input tokens; output tokens free | Many small questions are affordable; input size is the cost driver |
| Rate limits 250k tokens/s and 1,200 requests/min, subject to change | Bounded concurrency with the SDK's retry policy |
| `jev-latest` is an alias that moves | Pin `jev-1.13.0` for any run whose numbers are compared |
| State is not treated as hostile | Document text can steer answers; thresholds and the judge are the backstop |

## 3. Pipeline

```
PDF ─▶ 1 extract text ─▶ 2 normalize, split, tokenize, chunk
    ─▶ 3a tag tokens (Jev) ─▶ 3b assemble spans (code) ─▶ 3c resolve spans (Jev: boundary, then type)
    ─▶ 4 resolve entities (code blocking + Jev)
    ─▶ 5 extract relations (code pairs + Jev)
    ─▶ 6 write graph (Neo4j)
    ─▶ 7 judge (Claude) and 8 benchmark report, both offline over the run's artifacts
```

Each stage reads and writes JSON files under `out/<runId>/`, so a stage can be re-run,
inspected or judged without repeating the ones before it.

### 3.1 PDF text extraction

Library: `unpdf`, a pdf.js build for Node. The requirement is per-page text in reading
order. Output is
`pages[]` with `{ page, text }`. A page with almost no extractable text is reported as
"probably scanned" and skipped with a warning, not silently dropped.

### 3.2 Normalize, split, tokenize, chunk

- Normalize: rejoin words hyphenated across line breaks (a hyphen followed by a capital
  keeps the hyphen: "Al-" / "Qaida" is "Al-Qaida"), collapse hard line wraps inside
  paragraphs, strip repeated headers and footers, and give a heading its own paragraph. A
  heading has no full stop, so "Item 10" would otherwise fuse with the sentence under it;
  a short unpunctuated line followed by a capitalized line is treated as a heading.
  Keep a map from normalized offsets back to pages so every later span can cite its page.
- Sentences: `Intl.Segmenter` with `granularity: "sentence"`, followed by a merge pass,
  because the segmenter breaks after "Dr.", after an initial, and after "No." in "Decision
  No. 17820". No dependency needed.
- Tokens: a regex tokenizer that keeps `U.S.`, `J.`, `St.`, `O'Brien`, `AT&T` and
  `1,315.50` whole, splits possessive `'s`, and emits every other punctuation mark as its
  own token, the hyphen included. "Hewlett-Packard" is rejoined in 3b, while "New
  York-based" correctly yields "New York". Each token carries `start` and `end`.
- Chunks: consecutive sentences up to 80 askable tokens (tokens containing a letter or
  digit). Each token is asked about in exactly one chunk. The chunk's state may include
  the previous sentence as `context_before`, and nothing else.

### 3.3 NER

**3a. Tag tokens.** One request per chunk, one Choice per askable token. Punctuation is
never asked about. The first chunk of a run goes alone, as a probe: its `usage` tells the
budget what a question costs under the current schema, and the remaining chunks are then
batched as large as the request limit allows. A token pacer spaces request starts to stay
under Jev's tokens-per-second limit (200k by default, `TYPESAFE_TOKENS_PER_SECOND` to
change it); without it, a schema with many kinds pushes six concurrent requests past the
limit and the run dies on 429s.

Two ways of telling Jev what the kinds mean are supported. The original design repeats every
kind's description in each question's criteria (`--no-lean`). Lean mode sends the
descriptions once, in `state.kinds`, and leaves the criteria as bare labels. With the
twelve-kind schema it used about a quarter of the tokens and scored higher on the gold
passages, the sample and the IMF paper (judged F1 74.6% against 66.2%), so it is the
default. The benchmark keeps both: `resolve-*` repeat the definitions, `lean-80` does not.

```jsonc
// state
{ "context_before": "…previous sentence…", "text": "Tim Cook said Apple will open an office in Austin." }

// one question per token; instructions are a structured object, which the API allows
{
  "type": "choice",
  "instructions": {
    "task": "Decide which kind of named entity the word marked with [[ ]] is part of, as it is used in `text`. If the word is one word of a longer name, answer with the kind of the longer name: 'York' in 'New York Times' is part of an organization.",
    "word": "Apple",
    "marked_in_context": "Tim Cook said [[Apple]] will open an office"
  },
  "criteria": {
    "person": "…description from schema…",
    "organization": "…",
    "location": "…",
    "none": "The word is not part of any named entity."
  }
}
```

Quoting the word with its neighbours avoids a `tokens[17]`-style lookup, which would be
one hop of indirection, and it disambiguates a word that appears twice in the chunk. The
second sentence of the task was added after live testing: read literally, "Lisbon" is a
location even inside "Lisbon Climate Forum", which split the event's name in two.

Decision in code: `pEntity = 1 − P(none)`. A token is an entity token when
`pEntity ≥ 0.5`, and its type is the highest-probability option other than `none`.

**3b. Assemble spans.** Adjacent entity tokens of the same type merge into one span. The
joiners `&`, `-`, `'` and `’` bridge a merge; a sentence boundary never does, and neither
does a slash, which separates alternatives ("Al-Qaida/ISIL" is two organizations). A span
never starts with a lowercase article, preposition or conjunction ("of the Council…" is
"Council…"), nor with a capitalized article that opens its sentence. "in The Hague" keeps
its article because it is mid-sentence. A span never ends with such a word either
("2026/1211 of"), and it never opens with a possessive or demonstrative ("its chief
technology officer"). A bracket that hugs the word inside it can sit inside a name, so
"Regulation (EU) 2016/44" is one span, and a span that opens a bracket takes the closing
one. These rules all came from the first real document.

**3c. Resolve spans.** Two requests per chunk, in order:

1. `boundary`, one Choice per span. The options are verbatim candidate strings: the span
   itself, the span grown by up to two tokens on each side, the span shrunk by up to two
   tokens on each side (one was not enough to turn "Fjord X1 warehouse robot" into "Fjord
   X1"), the span joined with a neighbouring span at most two tokens away, and
   `none`. Code copies the chosen string and looks up its offsets, so a boundary fix can
   never invent text. This is what turns `Bank` + `America` back into `Bank of America`.
   The question lists the schema's kinds with their descriptions, because "named entity"
   alone is read literally: a year is not a name, and dates were being answered `none`.
2. Code drops overlaps: an accepted span beats a review-band one, then the longer span
   wins, then confidence. A fragment's boundary question is biased towards keeping the
   fragment, so when a neighbour already resolved to the full name, the full name stands.
3. `type`, one Choice per surviving phrase: the schema's types plus `not_an_entity`.

The first build asked both questions in one request, typing the span before its boundary
was known. Live testing showed why that is wrong: "Dubai" is a location, so "Dubai Supply
Chain Expo" came out typed as a location. The type request needs the boundary answers to
build its questions, which is the case where a second request is justified.

Mention confidence is `(1 − P(boundary = none)) × P(type choice)`. The probability of
the chosen boundary itself is stored as `boundaryP` for diagnostics but does not enter
the confidence: the first live run showed it splitting between two acceptable answers
("Austin" and "Austin, Texas"), which says nothing about whether the span is an entity.
Starting thresholds: accept at 0.70 and above, flag for review from 0.40, drop below that. Identical spans
dedupe; overlapping spans keep the more confident one. Thresholds are tuned on the gold
set against a pinned model version and are not carried across versions.

### 3.4 Entity resolution within a document

1. Exact match on normalized surface form and type merges without a model call.
2. Code proposes candidate pairs of the same type: one name's tokens are a subset of the
   other's (`Cook`, `Tim Cook`), acronym match (`IBM`, `International Business
   Machines`), or Jaro-Winkler similarity of 0.85 or more.
3. Jev decides each pair with one Score question, following the entity-alignment
   cookbook. State is `{ entity_a, entity_b }`, each with name, type and up to two
   sentences of context. The levels are "different entities", "possibly the same
   entity" and "the same entity", routed by nearest level to keep apart, review, or
   merge. The levels carry the decision, so there is no threshold to fit.
4. Union-find builds clusters. The canonical name is the longest surface form, since
   the longest is the most specific ("Tim Cook" over "Cook"); frequency breaks ties.
   Pairs that land on "review" stay unmerged and are listed in the
   run report, because a wrong merge is the expensive mistake in a graph.

### 3.5 Relation extraction

1. Code proposes pairs: two distinct entities with mentions in the same sentence, where
   the schema has at least one relation whose `domain` and `range` fit the two types. A
   sentence that would produce more than 15 pairs is logged and capped.
2. One request per chunk carries every pair question for that chunk. Each is a Choice:

```jsonc
{
  "type": "choice",
  "instructions": {
    "task": "Which relationship between A and B does the text explicitly state?",
    "A": "Tim Cook (person)",
    "B": "Apple (organization)"
  },
  "criteria": {
    "A_works_for_B": "A is employed by, leads, or holds a role at B.",
    "A_founded_B": "A created or co-founded B.",
    "none": "The text does not state any of these relationships between A and B."
  }
}
```

   Options are generated from the schema for the pair's type signature. When both
   directions are valid, as with two organizations and `acquired`, both directed
   options appear. Jev's literal reading helps here: "explicitly state" keeps it from
   inferring relations the sentence does not contain.
3. Accept at `P ≥ 0.70`; the 0.40–0.70 band is kept with `needsReview: true` and is left
   out of the graph unless `--include-review` is passed.
4. The same `(a, relation, b)` found in several sentences becomes one edge with
   `evidence[]`, `count`, and `confidence` equal to the maximum.

### 3.6 Schema file

`schema/default.schema.json` defines entity types and relation types. Descriptions go
straight into Choice criteria, so editing the file changes the extractor without code
changes. They are the main tuning surface: on the starter gold set, rewriting them to say
what is *not* part of a name moved entity F1 from 89.5% to 98.2% with no code change.
`exactMatchOnly` lists types that merge on identical text only and never through fuzzy
pairing, since "2004" and "2005" are one character apart and different dates. Numbered
documents are in it for the same reason: "2016/44" is not "2016/48".

The shipped schema has twelve kinds: person, organization, location, officer, document,
product, service, event, date, finding, recommendation and other. Three lessons from
adding the last six. Kinds that overlap need their borders written down in both
descriptions (a job title is an officer and not part of a person's name; a named service
is a service and not a product). `other` needs to say that an ordinary word is never
"other", or it becomes a catch-all. And `finding` and `recommendation` are clauses, not
names: a word-by-word tagger returns fragments of them ("foreign reserves remain"), so
they belong in a sentence-level stage that v1 does not have. The default set is generic and is expected to be replaced once the document
domain is known (open question 3).

```jsonc
{
  "entities": {
    "person": "A named individual human, such as 'Maria Chen'. Job titles, honorifics and pronouns are not part of the name.",
    "product": "The brand or model name of a commercial product, service or software, such as 'Vision Pro'. Generic words for the kind of thing, such as robot, drone, app, sensor or service, are not part of the name.",
    "date": "A specific calendar date, month or year, such as '12 June 2024', 'March 2021' or '2019'. Prepositions are not part of it, and relative expressions such as 'last year' or 'next quarter' are not dates."
    // organization, location and event follow the same pattern; see the file
  },
  "exactMatchOnly": ["date"],
  "relations": {
    "works_for":     { "domain": ["person"], "range": ["organization"], "text": "A is employed by, leads, or holds a role at B." },
    "founded":       { "domain": ["person"], "range": ["organization"], "text": "A created or co-founded B." },
    "acquired":      { "domain": ["organization"], "range": ["organization"], "text": "A bought or took control of B." },
    "subsidiary_of": { "domain": ["organization"], "range": ["organization"], "text": "A is owned or controlled by B." },
    "located_in":    { "domain": ["organization", "location", "event"], "range": ["location"], "text": "A is situated or headquartered in B, or took place in B." },
    "produces":      { "domain": ["organization"], "range": ["product"], "text": "A makes, sells or operates B." },
    "participated_in": { "domain": ["person", "organization"], "range": ["event"], "text": "A took part in B." },
    "occurred_on":   { "domain": ["event"], "range": ["date"], "text": "A happened on or during B." }
  }
}
```

## 4. Graph model

Target: Neo4j 5 through `neo4j-driver`, run locally with `docker-compose.yml`. The
writer sits behind a `GraphStore` interface with a second implementation that emits a
`.cypher` file, so the pipeline runs end to end without a database. Swapping to another
graph database means one new class (open question 2).

```
(:SourceDocument {id, sha256, path, title, pageCount, ingestedAt})   // the PDF itself
(:Entity:Person {id, canonicalName, type, aliases, confidence})     // one extra label per type
(:Entity)-[:MENTIONED_IN {count, pages, runId}]->(:SourceDocument)
(:Entity)-[:WORKS_FOR {confidence, count, evidence, pages, docId, chunkIds, model, runId, needsReview}]->(:Entity)
```

- `Entity.id` is a hash of type plus normalized canonical name. `MERGE` on it makes
  loads idempotent and gives a basic cross-document join for free.
- Re-ingesting a document deletes that `docId`'s edges and `MENTIONED_IN` links first,
  then writes the new run.
- Uniqueness constraints on `SourceDocument.id` and `Entity.id`, created at start-up. The
  PDF's node was `:Document` until the schema gained a `document` entity kind, whose nodes
  are `:Entity:Document`. A start-up statement relabels source nodes in graphs written
  before the change, and the schema loader rejects kinds named `entity`, `mention` or
  `source_document`.
- Cypher cannot take a relationship type as a parameter, so the type is interpolated
  into the query. It is only ever taken from the schema file's keys, validated against
  `^[a-z_]+$` and upper-cased. Text from a document never reaches a query string; all
  values go through parameters.
- `--with-mentions` additionally writes `(:Mention {text, start, end, page, confidence})`
  nodes linked by `REFERS_TO`, for full provenance. Off by default to keep graphs small.

## 5. CLI

| Command | What it does |
| --- | --- |
| `nerjev run <pdf>` | Stages 1–6: PDF to graph |
| `nerjev extract <pdf>` | Stages 1–5, writes JSON under `out/<runId>/`, touches no database |
| `nerjev load <runDir>` | Stage 6 from an existing run |
| `nerjev gold` | Scores the extractor against `bench/gold/` by exact match and lists every false positive and miss. No judge |
| `nerjev eval <runDir>` | LLM judge over a run; writes `judge.jsonl` and `accuracy.json` |
| `nerjev judge-check` | Checks the judge against the gold labels and the known negatives of section 7 |
| `nerjev bench` | Runs variants × documents × repetitions and writes the report. `--judge` adds judged accuracy |
| `nerjev report <benchDir>` | Rebuilds a benchmark's report from saved data with no API calls, for use after a price change |
| `nerjev dashboard <benchDir>` | Builds a self-contained HTML dashboard of a benchmark, with optional findings and judge calibration |
| `nerjev inspect <pdf> --chunk N` | Prints the exact Jev request JSON for one chunk, ready to paste into the TypeSafe Playground |

Common flags: `--schema <file>`, `--out <dir>`, `--model <id>`, `--concurrency <n>`
(default 6), `--no-resolve` (skip 3c), `--accept <p>` and `--review <p>` (confidence
thresholds), `--no-lean` (kind definitions in every question instead of once in the
state), `--include-review`,
`--no-cache`, `--json`.
Exit code 0 on success, 1 on a failed stage, 2 on bad input or missing keys.

## 6. Tech stack and layout

Node 20 or newer (the TypeSafe JS SDK's floor), TypeScript in strict mode, ESM. `tsx`
for development and `tsc` for builds. `commander` for the CLI, `zod` for config, schema
file and judge output validation, `p-limit` for concurrency, `vitest` for tests, npm as
the package manager.

```
src/
  cli.ts  config.ts
  pdf/extract.ts
  text/{normalize,sentences,tokenize,chunk}.ts
  jev/{client,budget,cache}.ts
  ner/{tag,assemble,resolve}.ts
  entities/{block,align,cluster}.ts
  relations/{candidates,classify,aggregate}.ts
  graph/{store,neo4j,cypherExport}.ts
  eval/{judge,rubric,gold,metrics}.ts
  bench/{runner,recorder,pricing,report}.ts
  telemetry/instrumentedFetch.ts
schema/default.schema.json
bench/{docs/,gold/,pricing.json}
tests/
```

TypeSafe client notes, from the JS SDK reference: `new TypeSafeClient({ timeout, fetch,
defaultModel, retry })`, `client.systemOne({ state, questions, model })`, question
helpers `choice()`, `noul()`, `score()`, and a result of `{ answers, model, usage: {
input_tokens, output_tokens } }`. The default timeout is 10 s per attempt, which is too
short for an 80-question request; set 60 s. Retries default to 2, on 408, 429 and 5xx,
honouring `Retry-After`.

Both SDKs read their keys from the environment (`TYPESAFE_API_KEY`,
`ANTHROPIC_API_KEY`). Keys live in `.env`, which is gitignored; `.env.example` is the
committed template. The CLI loads it with `process.loadEnvFile`, so no dotenv dependency. The
SDKs' debug logging prints request bodies unredacted, so it stays off by default.

Response cache: Jev answers are cached on disk under `.cache/`, keyed by a hash of
model, state and questions. Re-running a pipeline or a judge pass costs nothing and is
deterministic. Benchmark runs always bypass the cache.

Token budget: `jev/budget.ts` starts at 80 questions per request, reads the real
`usage.input_tokens` from the first responses, and shrinks the batch size if a request
would pass 48k tokens. No string-length token estimates anywhere.

## 7. Evaluation: the LLM judge

The judge is Claude through `@anthropic-ai/sdk`, model taken from `JUDGE_MODEL`.
Default `claude-opus-5` (see open question 1 about "Opus 5.1"). Calls use
`client.messages.parse()` with a zod schema through `zodOutputFormat`, adaptive
thinking, effort `high`, and `max_tokens` 16000. The judge's `stop_reason` is checked
before its output is read. Server-side model fallbacks are left off for the judge on
purpose: a verdict must never come silently from a different model than the one named
in the report, so a refusal or truncation is recorded as `judge_error` and the row is
excluded and counted.

One judge call per chunk. It receives the chunk text, the mentions and the relations
extracted from it, and returns a separate verdict per property, never one blended
score:

| Item | Verdicts |
| --- | --- |
| Each mention | `is_entity`, `boundary_exact`, `type_correct` |
| Each relation | `supported_by_text`, `type_correct`, `direction_correct` |
| The chunk | `missed_entities[]` and `missed_relations[]`, each with a verbatim quote |

Code verifies that every quoted miss is a substring of the chunk and discards it
otherwise, so the judge cannot lower recall by inventing text. Entity resolution is
judged separately on a sample of clusters: "do all of these mentions refer to the same
real-world entity?"

Metrics derived from the verdicts:

- Entity precision, recall and F1, strict (all three verdicts true) and relaxed
  (boundary may be off, with overlap).
- Relation precision, recall and F1. Recall uses correct plus judge-listed misses as
  the denominator, so it is an estimate and is labelled as one.
- Type accuracy on correctly detected entities; cluster purity for entity resolution.
- Calibration of Jev's confidence: bucket mentions and relations by confidence, compare
  with the judged-correct rate, report a reliability table and expected calibration
  error. This checks the "calibrated probabilities" claim on our documents, and it is
  what justifies the thresholds in 3.3 and 3.5.

Keeping the judge trustworthy:

- A hand-labelled gold set in `bench/gold/` gives programmatic exact-match P/R/F1 with no
  judge involved. The target is 25 to 30 chunks from the benchmark documents. What ships
  is a starter set of 12 fictional passages, which the prompts were tuned against, so
  its scores are development numbers and not a held-out test. The judge
  must agree with the gold labels on at least 90% of clear-cut items before its scores
  are used for anything.
- Known negatives must fail: an empty extraction, an extraction with types shuffled,
  and an extraction taken from a different chunk.
- The judge never sees variant names or which system produced an extraction. Chunk text
  and extracted strings are passed as delimited data with an instruction to treat them
  as data, since a PDF can contain text addressed to a model.
- The judge is run twice on a 10% sample, and its self-agreement is reported as the
  noise floor next to every accuracy number.
- If a Claude-based extractor is added as a baseline (open question 4), the judge and
  that baseline share a model family, which tends to favour the baseline. In that case
  the gold-set numbers decide close calls.

## 8. Benchmark

`nerjev bench` runs each variant on each document in `bench/docs/`, three repetitions,
cache off, fixed concurrency, and a pinned Jev version.

Variants for v1: token tagging only (`--no-resolve`); token tagging plus span
resolution (the default); chunk sizes of 40, 80 and 160 askable tokens; and `lean-80`,
the default pipeline with the kind definitions sent once in the state. A repetition that
fails is logged to `failures.txt` and skipped, so one bad run does not cost the benchmark. At about 460
input tokens per tag question, a 160-token chunk still splits into requests of about 80
questions to stay inside the request limit, so it changes the state size and not the
number of tagging calls. Optional
baseline: Claude extracting entities and relations in one structured-output call per
chunk (open question 4).

Every API call, Jev or Claude, appends one row to `out/<runId>/calls.jsonl`:

| Field | Source |
| --- | --- |
| `runId`, `variant`, `docId`, `chunkId`, `stage` | harness; stage is `ner_tag`, `ner_resolve`, `ner_type`, `entity_align`, `relation` or `judge` |
| `provider`, `model` | `model` is the value the response reports, not the one requested |
| `requestId` | response header (`x-typesafe-request-id` for Jev) |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | the response's `usage` block; cache fields are Claude only |
| `latencyMs` | the final successful attempt only |
| `wallMs`, `attempts`, `statusCodes[]` | includes retries and backoff; counts 429 and 529 |
| `requestBytes`, `responseBytes` | UTF-8 byte length of the serialized bodies |
| `questionCount`, `stateChars` | Jev only |

Measurement comes from one place: `telemetry/instrumentedFetch.ts`, a wrapper around
`fetch` that is passed to the `fetch` option that both the TypeSafe and the Anthropic
client accept. It
times each attempt, measures body sizes and captures status codes and headers, so
application code cannot forget to record a call. Time spent waiting on the local
concurrency limiter is excluded from `latencyMs`.

Cost is never stored. The report computes it from recorded tokens and
`bench/pricing.json`, keyed by the reported model, so a price change means re-running
the report and not the benchmark. Seed values are list prices on 2026-09-19 and should
be re-checked before any number is published: `jev-1.13.0` at $0.042 per million input
tokens with output free, `claude-opus-5` at $5 and $25 per million input and output
tokens, `claude-fable-5-1` at $10 and $50.

The report (`report.md` plus `summary.csv`) gives, per variant and per document:

- Tokens: input and output, in total, per call (min, median, max), per page and per
  stage.
- Speed: latency p50 and p95 per stage, wall-clock time for the whole document, pages
  per minute, input tokens per second, retry and rate-limit counts.
- Accuracy: every metric from section 7, judge-based and gold-based in adjacent
  columns, with the judge's noise floor.
- Cost: per call, per stage, per page, per document, per accepted entity and per
  accepted relation. Judge cost is a separate line and is never folded into pipeline
  cost.
- Payload: request and response bytes per call and per document, questions per
  request, bytes per input token.
- Yield: entities and relations per page, share sent to review, merge and review
  counts from entity resolution.

Quality and cost appear in the same table for each variant, as absolute numbers, so
the trade-off can be read directly. With three repetitions the report gives the mean
and the range, and it says so when the difference between two variants is inside the
judge's noise floor.

### 8.1 A second actor: an LLM answering the same questions

To ask whether Jev can stand in for an LLM, the comparison has to change one thing only.
The pipeline is therefore written against an `Answerer`: something that takes a state and
a map of typed questions and returns Jev-shaped answers. Jev is one implementation.
`ClaudeAnswerer` is the other: it sends an LLM the identical request body, `{state,
questions}`, as the user message, and gets back one option and one confidence per question
id through structured output. The same data, the same chunks, the same stages, the same
questions and the same code around them; only the model that answers differs.

- The only text the LLM gets that Jev does not is a protocol description: what a choice,
  a score and a noul are, that an option must be copied character for character, that
  questions are independent, and that the state is data. It says nothing about entities.
- Jev returns a probability per option. An LLM returns one answer, so it is also asked for
  a confidence, which code spreads into the same shape. That number is self-reported, and
  the calibration chart says so.
- An LLM generates its answer, so it can return an option that was never offered, for
  instance a boundary phrase re-typed with a slip. Such an answer, or a skipped question,
  becomes a certain `none` and is counted in the run's manifest. Text the model generated
  is never trusted as a span.
- Server-side model fallbacks stay off for this actor as for the judge: a benchmark row
  has to come from the model it names.
- Variant `opus-lean-80` mirrors `lean-80`. It runs only when named in `--variants`,
  with its own `--claude-reps` (default 1), because it costs about 200 times more per
  document. `ANSWERER_MODEL` (default `claude-opus-5`) and `ANSWERER_EFFORT` (default
  `low`, the production-like setting for high-volume classification) configure it, and
  `--answerer claude` does the same for `run`, `extract` and `gold`.
- The judge defaults to `claude-fable-5-1`. It and the LLM actor are both Claude models,
  and a judge tends to favour output that resembles its own family's. The exact-match gold
  scores involve no judge and are the tie-breaker.

## 9. Testing

Unit tests with `vitest` need no network: tokenizer offsets and edge cases, chunking,
span assembly, boundary-candidate generation, overlap handling, pair blocking,
union-find clustering, relation option generation from a schema, Cypher generation
(including rejection of a relation type that fails the whitelist), metric arithmetic,
and cost computation. Jev and Claude are replaced by fakes injected through the same
`fetch` option the telemetry uses. One opt-in integration test (`npm run test:live`)
runs a single known paragraph end to end against the real APIs.

## 10. Milestones

| # | Deliverable | Done when |
| --- | --- | --- |
All seven milestones were met on 2026-09-19 against the live APIs; the evidence is in the
README and in `bench/results/2026-09-19-sample/`.

| M0 | Scaffold: package, tsconfig, CLI skeleton, config, instrumented fetch | `nerjev --help` runs; unit tests pass |
| M1 | PDF to chunks | `extract` writes pages, sentences, tokens and chunks with a correct offset-to-page map for a sample PDF |
| M2 | NER (3a–3c) | Mentions with offsets, types and confidences; `inspect` output works in the Playground |
| M3 | Entity resolution and relations | `entities.json` and `relations.json`, each relation with evidence |
| M4 | Graph | `run` fills Neo4j; loading twice changes nothing; `.cypher` export works with no database |
| M5 | Judge and gold set | `eval` writes verdicts and metrics; judge passes the 90% agreement and known-negative checks |
| M6 | Benchmark | `bench` writes `calls.jsonl`, `report.md` and `summary.csv` covering every metric in section 8 |

## 11. Open questions

1. **Judge model.** The request was "Claude Opus 5.1", which is not a published model
   ID. The current IDs are `claude-opus-5` (Opus 5) and `claude-fable-5-1` (Fable 5.1,
   the most capable model, at twice the price). The spec defaults to `claude-opus-5`
   through `JUDGE_MODEL`. Which one was meant?
2. **Graph database.** Resolved: Neo4j. `docker-compose.yml` starts a local instance
   with its ports published, which the app needs in order to reach it.
3. **Documents.** What kind of PDFs, and in which language? The domain sets the entity
   and relation schema. If they are in Spanish, Jev's accuracy needs to be measured
   before anything else, since English is its primary language.
4. **Baseline.** Should the benchmark include a generative baseline, Claude doing the
   same extraction, so the Jev numbers have something to be compared with? It roughly
   doubles the benchmark's scope and adds the judge-bias caveat from section 7.
5. **Gold set.** The starter set is 12 fictional passages. Who labels 25 to 30 chunks
   from the real documents? Until then, accuracy numbers say little about real use.
6. **Data handling.** Document text goes to two outside APIs, TypeSafe for extraction
   and Anthropic for judging. Is that acceptable for the intended documents?
