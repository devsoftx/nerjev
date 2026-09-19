import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { normalizePages, type RawPage } from "../text/normalize.js";
import type { DocumentText } from "../types.js";

/** A page with fewer characters than this is reported as probably scanned. */
const MIN_PAGE_CHARS = 20;

export async function extractPdf(path: string): Promise<DocumentText> {
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const meta = await getMeta(pdf).catch(() => null);

  const pages: RawPage[] = text.map((pageText, i) => ({ page: i + 1, text: pageText }));
  const skippedPages = pages.filter((p) => p.text.trim().length < MIN_PAGE_CHARS).map((p) => p.page);
  const normalized = normalizePages(pages.filter((p) => !skippedPages.includes(p.page)));

  const metaTitle = typeof meta?.info?.Title === "string" ? meta.info.Title.trim() : "";
  return {
    id: sha256.slice(0, 16),
    sha256,
    path,
    title: metaTitle || basename(path).replace(/\.pdf$/i, ""),
    pageCount: totalPages,
    text: normalized.text,
    pageMap: normalized.pageMap,
    skippedPages,
  };
}

/** Wrap plain text as a one-page document, for gold passages and tests. */
export function documentFromText(text: string, name: string): DocumentText {
  const sha256 = createHash("sha256").update(text).digest("hex");
  const normalized = normalizePages([{ page: 1, text }]);
  return {
    id: sha256.slice(0, 16),
    sha256,
    path: name,
    title: name,
    pageCount: 1,
    text: normalized.text,
    pageMap: normalized.pageMap,
    skippedPages: [],
  };
}
