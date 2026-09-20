import { isAskable } from "../text/tokenize.js";
import type { Chunk, Span, Token, TokenTag } from "../types.js";

/** Punctuation that may sit inside a name. All but "&" must touch the words on both sides. */
const TIGHT_JOINERS = new Set(["-", "–", "'", "’"]);
const LOOSE_JOINERS = new Set(["&"]);
/** "Regulation (EU) 2016/44": an opening bracket joins when it touches the word after it, a closing one the word before. */
const OPENERS = new Set(["(", "["]);
const CLOSERS = new Set([")", "]"]);

const ARTICLES = new Set(["the", "a", "an"]);
/** Lowercase words that can sit inside a name ("Bank of America") but never open one. */
const FUNCTION_WORDS = new Set([...ARTICLES, "of", "in", "on", "at", "by", "for", "to", "from", "and", "or", "its", "his", "her", "their", "our", "this", "that", "these", "those"]);

/**
 * A word that cannot be the first word of a name, whatever the tagger said about it: a lowercase
 * article, preposition or conjunction ("of the Council..." is "Council..."), or a capitalized
 * article that opens its sentence ("The Meridian Open was held..."). A capitalized article inside a
 * sentence is left alone, so "in The Hague" keeps its name.
 */
/**
 * Where a span from `start` to `last` should end. A span that opens a bracket takes the closing
 * bracket that directly follows it, so "ISIL (Da'esh" becomes "ISIL (Da'esh)".
 */
export function spanEnd(docText: string, tokens: Token[], start: number, last: Token): number {
  const text = docText.slice(start, last.end);
  const opened = (text.match(/[([]/g) ?? []).length > (text.match(/[)\]]/g) ?? []).length;
  const after = tokens[last.index + 1];
  return opened && after && CLOSERS.has(after.text) && after.start === last.end ? after.end : last.end;
}

/** A lowercase article, preposition or conjunction cannot close a name any more than open one. */
export const isTrailingFunctionWord = (token: Token) => FUNCTION_WORDS.has(token.text);

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
  if (OPENERS.has(middle.text)) return middle.end === tokens[b]!.start;
  if (CLOSERS.has(middle.text)) return tokens[a]!.end === middle.start;
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
    while (run.length && isTrailingFunctionWord(run[run.length - 1]!)) run.pop();
    if (!run.length) return;
    const type = tagByToken.get(run[0]!.index)!.type!;
    const start = run[0]!.start;
    const end = spanEnd(docText, tokens, start, run[run.length - 1]!);
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
