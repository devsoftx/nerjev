import { isAskable } from "../text/tokenize.js";
import type { Chunk, Span, Token, TokenTag } from "../types.js";

/** Punctuation that may sit inside a name. All but "&" must touch the words on both sides. */
const TIGHT_JOINERS = new Set(["-", "–", "'", "’"]);
const LOOSE_JOINERS = new Set(["&"]);

const ARTICLES = new Set(["the", "a", "an"]);
/** Lowercase words that can sit inside a name ("Bank of America") but never open one. */
const FUNCTION_WORDS = new Set([...ARTICLES, "of", "in", "on", "at", "by", "for", "to", "from", "and", "or"]);

/**
 * A word that cannot be the first word of a name, whatever the tagger said about it: a lowercase
 * article, preposition or conjunction ("of the Council..." is "Council..."), or a capitalized
 * article that opens its sentence ("The Meridian Open was held..."). A capitalized article inside a
 * sentence is left alone, so "in The Hague" keeps its name.
 */
export function isLeadingArticle(tokens: Token[], token: Token): boolean {
  if (FUNCTION_WORDS.has(token.text)) return true;
  const opensSentence = token.index === 0 || tokens[token.index - 1]!.sentence !== token.sentence;
  return opensSentence && ARTICLES.has(token.text.toLowerCase());
}

/** Whether entity tokens a and b (a < b) belong to one span, given the tokens between them. */
function joins(tokens: Token[], a: number, b: number): boolean {
  if (tokens[a]!.sentence !== tokens[b]!.sentence) return false;
  if (b === a + 1) return true;
  if (b !== a + 2) return false;
  const middle = tokens[a + 1]!;
  if (middle.kind !== "punct") return false;
  if (LOOSE_JOINERS.has(middle.text)) return true;
  return TIGHT_JOINERS.has(middle.text) && tokens[a]!.end === middle.start && middle.end === tokens[b]!.start;
}

/** Merges adjacent entity tokens of the same type into spans. A sentence boundary never joins. */
export function assembleSpans(docText: string, tokens: Token[], chunk: Chunk, tags: TokenTag[]): Span[] {
  const tagByToken = new Map(tags.map((tag) => [tag.token, tag]));
  const entityTokens = tokens
    .slice(chunk.tokenStart, chunk.tokenEnd)
    .filter((token) => isAskable(token) && tagByToken.get(token.index)?.type);

  const spans: Span[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (!run.length) return;
    const type = tagByToken.get(run[0]!.index)!.type!;
    const start = run[0]!.start;
    const end = run[run.length - 1]!.end;
    const score = run.reduce((sum, t) => sum + (tagByToken.get(t.index)!.probabilities[type] ?? 0), 0) / run.length;
    spans.push({
      chunkId: chunk.id,
      tokenStart: run[0]!.index,
      tokenEnd: run[run.length - 1]!.index,
      start,
      end,
      text: docText.slice(start, end),
      type,
      score,
    });
    run = [];
  };

  for (const token of entityTokens) {
    const previous = run[run.length - 1];
    const sameType = previous && tagByToken.get(previous.index)!.type === tagByToken.get(token.index)!.type;
    if (previous && !(sameType && joins(tokens, previous.index, token.index))) flush();
    if (!run.length && isLeadingArticle(tokens, token)) continue;
    run.push(token);
  }
  flush();
  return spans;
}
