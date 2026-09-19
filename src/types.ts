/** Shared data contracts. Every stage reads and writes these as JSON under out/<runId>/. */

export interface PageSpan {
  page: number;
  /** Offsets into DocumentText.text. */
  start: number;
  end: number;
}

export interface DocumentText {
  id: string;
  sha256: string;
  path: string;
  title: string;
  pageCount: number;
  /** Normalized text of the whole document. All later offsets index into this string. */
  text: string;
  pageMap: PageSpan[];
  /** Pages with almost no extractable text, probably scanned. */
  skippedPages: number[];
}

export interface Sentence {
  index: number;
  start: number;
  end: number;
}

export type TokenKind = "word" | "number" | "possessive" | "punct";

export interface Token {
  index: number;
  text: string;
  start: number;
  end: number;
  kind: TokenKind;
  sentence: number;
}

export interface Chunk {
  id: string;
  index: number;
  start: number;
  end: number;
  text: string;
  contextBefore: string;
  /** Sentence indices, end exclusive. */
  sentenceStart: number;
  sentenceEnd: number;
  /** Token indices, end exclusive. */
  tokenStart: number;
  tokenEnd: number;
}

export interface Segmented {
  sentences: Sentence[];
  tokens: Token[];
  chunks: Chunk[];
}

export interface TokenTag {
  token: number;
  probabilities: Record<string, number>;
  pEntity: number;
  type: string | null;
}

/** A run of adjacent entity tokens of one type, before boundary resolution. Token range is inclusive. */
export interface Span {
  chunkId: string;
  tokenStart: number;
  tokenEnd: number;
  start: number;
  end: number;
  text: string;
  type: string;
  score: number;
}

export type ReviewStatus = "accepted" | "review";

export interface Mention {
  id: string;
  chunkId: string;
  sentence: number;
  text: string;
  start: number;
  end: number;
  page: number;
  type: string;
  confidence: number;
  boundaryP: number | null;
  typeP: number;
  status: ReviewStatus;
}

export interface Entity {
  id: string;
  type: string;
  canonicalName: string;
  aliases: string[];
  mentionIds: string[];
  confidence: number;
  pages: number[];
}

export interface AlignmentDecision {
  a: string;
  b: string;
  type: string;
  score: number;
  confidence: number;
  outcome: "different" | "review" | "same";
}

export interface Evidence {
  chunkId: string;
  sentence: string;
  page: number;
  probability: number;
}

export interface Relation {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  count: number;
  evidence: Evidence[];
  needsReview: boolean;
}

export interface RunManifest {
  runId: string;
  docId: string;
  variant: string;
  model: string;
  schemaPath: string;
  options: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  wallMs?: number;
  counts?: Record<string, number>;
}

/** Everything the graph writer needs for one document. */
export interface GraphData {
  runId: string;
  model: string;
  document: Pick<DocumentText, "id" | "sha256" | "path" | "title" | "pageCount">;
  entities: Entity[];
  relations: Relation[];
  mentions: Mention[];
}

export type Stage = "ner_tag" | "ner_resolve" | "ner_type" | "entity_align" | "relation" | "judge" | "baseline";

/** One row of calls.jsonl. Cost is never stored; the report derives it from tokens and the price table. */
export interface CallRecord {
  runId: string;
  variant: string;
  docId: string;
  chunkId: string | null;
  stage: Stage;
  provider: "typesafe" | "anthropic";
  /** The model the response reports, not the one requested. */
  model: string;
  requestId: string | null;
  startedAt: string;
  /** Final successful attempt only. */
  latencyMs: number | null;
  /** Includes retries and backoff, excludes time queued behind the local concurrency limit. */
  wallMs: number;
  attempts: number;
  statusCodes: number[];
  requestBytes: number | null;
  responseBytes: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  questionCount: number | null;
  stateChars: number | null;
  cached: boolean;
  error: string | null;
}
