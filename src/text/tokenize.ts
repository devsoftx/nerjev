import type { Sentence, Token, TokenKind } from "../types.js";
import { ABBREVIATIONS } from "./sentences.js";

/**
 * Alternatives are tried in order at each position:
 *   abbr    U.S.  e.g.            letter-period sequences
 *   title   Dr.  Inc.  St.        known abbreviations keep their period
 *   initial J.                    a capital initial followed by another capitalized word
 *   number  1,315.50  2024-05-01  12:30  45%
 *   poss    's                    split off so "Apple's" yields the entity "Apple"
 *   word    O'Brien  AT&T         apostrophe and ampersand join only without spaces
 *   punct   any other single character; a hyphen is punctuation so "York-based" splits
 */
const TOKEN = new RegExp(
  [
    String.raw`(?<abbr>(?:\p{L}\.){2,})`,
    String.raw`(?<title>\b(?:${ABBREVIATIONS.join("|")})\.)`,
    String.raw`(?<initial>\b\p{Lu}\.(?=\s+\p{Lu}))`,
    String.raw`(?<number>\p{N}+(?:[.,:/-]\p{N}+)*%?)`,
    String.raw`(?<poss>['’][sS](?![\p{L}\p{N}]))`,
    String.raw`(?<word>[\p{L}\p{N}]+(?:(?:['’](?![sS](?![\p{L}\p{N}]))|&)[\p{L}\p{N}]+)*)`,
    String.raw`(?<punct>\S)`,
  ].join("|"),
  "gu",
);

function kindOf(groups: Record<string, string | undefined>): TokenKind {
  if (groups.number !== undefined) return "number";
  if (groups.poss !== undefined) return "possessive";
  if (groups.punct !== undefined) return "punct";
  return "word";
}

/** Tokens that get a question. Punctuation and the possessive marker never do. */
export const isAskable = (token: Token) => token.kind === "word" || token.kind === "number";

export function tokenize(text: string, sentences: Sentence[]): Token[] {
  const tokens: Token[] = [];
  for (const sentence of sentences) {
    const slice = text.slice(sentence.start, sentence.end);
    for (const match of slice.matchAll(TOKEN)) {
      const start = sentence.start + match.index;
      tokens.push({
        index: tokens.length,
        text: match[0],
        start,
        end: start + match[0].length,
        kind: kindOf(match.groups ?? {}),
        sentence: sentence.index,
      });
    }
  }
  return tokens;
}
