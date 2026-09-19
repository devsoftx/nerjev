// Builds bench/docs/sample-newsletter.pdf from the gold passages: a multi-page PDF with a running
// header and footer and hard-wrapped lines, so PDF extraction and normalization have real work to do.
// Every company and person in it is fictional.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const WRAP_AT = 78;
const PASSAGES_PER_PAGE = 4;

interface Passage {
  id: string;
  text: string;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const passages = JSON.parse(readFileSync("bench/gold/starter.json", "utf8")) as Passage[];
const pdf = await PDFDocument.create();
pdf.setTitle("Sample Industry Newsletter");
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

const pageCount = Math.ceil(passages.length / PASSAGES_PER_PAGE);
for (let p = 0; p < pageCount; p++) {
  const page = pdf.addPage([595, 842]);
  page.drawText("Sample Industry Newsletter", { x: 50, y: 800, size: 9, font });
  let y = 760;
  for (const passage of passages.slice(p * PASSAGES_PER_PAGE, (p + 1) * PASSAGES_PER_PAGE)) {
    page.drawText(`Item ${passage.id.slice(1)}`, { x: 50, y, size: 12, font: bold });
    y -= 20;
    for (const line of wrap(passage.text, WRAP_AT)) {
      page.drawText(line, { x: 50, y, size: 11, font });
      y -= 15;
    }
    y -= 18;
  }
  page.drawText(`Page ${p + 1} of ${pageCount}`, { x: 50, y: 40, size: 9, font });
}

mkdirSync("bench/docs", { recursive: true });
writeFileSync("bench/docs/sample-newsletter.pdf", await pdf.save());
console.log(`wrote bench/docs/sample-newsletter.pdf (${pageCount} pages, ${passages.length} passages)`);
