/**
 * The requirement (or fix plan) Shape writes, as a PDF made in the browser:
 * the requirement form first, then each file of the OpenSpec draft under its
 * own heading — what the factory starts from when it is opened as work.
 * Nothing goes to the server, so an edited draft downloads as it stands.
 */
import { splitOpenSpec } from "./openspec.js";

export type SpecBlock =
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; lines: string[] }
  | { kind: "p"; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" };

/**
 * The light markdown Shape's specs are written in: headings, bullets,
 * numbered lines, paragraphs, fenced code and tables (kept as fixed-width
 * lines). The page shows it with the same reading.
 */
export function specBlocks(markdown: string): SpecBlock[] {
  const blocks: SpecBlock[] = [];
  let fence: string[] | null = null;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) {
        blocks.push({ kind: "code", lines: fence });
        fence = null;
      } else fence.push(raw.replace(/\t/g, "  "));
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = [];
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    const last = blocks[blocks.length - 1];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]!.trim() });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.startsWith("|")) {
      if (last?.kind === "code" && last.lines[0]?.trim().startsWith("|")) last.lines.push(line);
      else blocks.push({ kind: "code", lines: [line] });
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      const kind = bullet ? "ul" : "ol";
      const text = (bullet ?? num)![1]!;
      if (last && last.kind === kind) last.lines.push(text);
      else blocks.push({ kind, lines: [text] });
      continue;
    }
    blocks.push({ kind: "p", text: line.replace(/^>\s?/, "") });
  }
  if (fence) blocks.push({ kind: "code", lines: fence });
  return blocks;
}

/** `**bold**` runs inside a line, as the spec's WHEN/THEN keywords are written. */
export function inlineRuns(text: string): Array<{ text: string; bold: boolean }> {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((t, i) => ({ text: t.replace(/`([^`]+)`/g, "$1"), bold: i % 2 === 1 }))
    .filter((r) => r.text);
}

// The PDF's built-in fonts carry Windows-1252 only. Common symbols are spelled
// out; anything else outside it would print as garbage, so it becomes "?".
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const SPELLED: Record<string, string> = {
  "→": "->", "←": "<-", "⇒": "=>", "↔": "<->", "≥": ">=", "≤": "<=", "≠": "!=",
  "✓": "[x]", "✔": "[x]", "✗": "x", "✘": "x", "−": "-", "‑": "-", "‐": "-", "…": "...",
  " ": " ", " ": " ", " ": " ", "\t": "  ",
};

export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (SPELLED[ch] !== undefined) out += SPELLED[ch];
    else if ((code >= 32 && code < 127) || (code >= 160 && code < 256) || CP1252_EXTRA.includes(ch)) out += ch;
    else if (code > 0xffff || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d) continue; // emoji
    else out += "?";
  }
  return out;
}

export function pdfFileName(title: string, slug: string | null): string {
  const base = (slug ?? title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${base || "requirement"}.pdf`;
}

/** The jsPDF methods used here, so a test can hand in the real class. */
type Doc = InstanceType<typeof import("jspdf").jsPDF>;

const PAGE = { margin: 56, body: 10.5, lead: 1.45 };

class Writer {
  y: number;
  readonly width: number;
  readonly bottom: number;
  constructor(readonly doc: Doc) {
    this.y = PAGE.margin;
    this.width = doc.internal.pageSize.getWidth() - PAGE.margin * 2;
    this.bottom = doc.internal.pageSize.getHeight() - PAGE.margin;
  }

  room(h: number): void {
    if (this.y + h > this.bottom) {
      this.doc.addPage();
      this.y = PAGE.margin;
    }
  }

  gap(h: number): void {
    this.y += h;
  }

  /** Word-wrapped text with bold runs, starting at `indent`, an optional marker hanging left of it. */
  text(runs: Array<{ text: string; bold: boolean }>, size: number, opts: { indent?: number; marker?: string; font?: string } = {}): void {
    const font = opts.font ?? "helvetica";
    const indent = opts.indent ?? 0;
    const lineH = size * PAGE.lead;
    const max = this.width - indent;
    const words: Array<{ text: string; bold: boolean }> = [];
    for (const r of runs) for (const w of pdfSafe(r.text).split(/(\s+)/)) if (w) words.push({ text: w, bold: r.bold });

    const lines: Array<Array<{ text: string; bold: boolean }>> = [[]];
    let x = 0;
    const measure = (w: { text: string; bold: boolean }) => {
      this.doc.setFont(font, w.bold ? "bold" : "normal");
      this.doc.setFontSize(size);
      return this.doc.getTextWidth(w.text);
    };
    for (const w of words) {
      const cur = lines[lines.length - 1]!;
      if (/^\s+$/.test(w.text)) {
        if (cur.length) {
          cur.push({ text: " ", bold: w.bold });
          x += measure({ text: " ", bold: w.bold });
        }
        continue;
      }
      let piece = w;
      let wd = measure(piece);
      if (x + wd > max && cur.length) {
        while (cur.length && /^\s+$/.test(cur[cur.length - 1]!.text)) cur.pop();
        lines.push([]);
        x = 0;
      }
      // A word wider than the line (a long URL or path) is cut where it must be.
      while (wd > max) {
        let n = piece.text.length - 1;
        while (n > 1 && measure({ text: piece.text.slice(0, n), bold: piece.bold }) > max) n--;
        lines[lines.length - 1]!.push({ text: piece.text.slice(0, n), bold: piece.bold });
        lines.push([]);
        piece = { text: piece.text.slice(n), bold: piece.bold };
        wd = measure(piece);
      }
      lines[lines.length - 1]!.push(piece);
      x += wd;
    }

    lines.forEach((line, i) => {
      this.room(lineH);
      const base = this.y + size;
      if (i === 0 && opts.marker) {
        this.doc.setFont(font, "normal");
        this.doc.setFontSize(size);
        this.doc.text(opts.marker, PAGE.margin + indent - this.doc.getTextWidth(opts.marker) - 4, base);
      }
      let cx = PAGE.margin + indent;
      // One text call per run of the same weight keeps the PDF's text searchable.
      const merged: Array<{ text: string; bold: boolean }> = [];
      for (const w of line) {
        const prev = merged[merged.length - 1];
        if (prev && prev.bold === w.bold) prev.text += w.text;
        else merged.push({ ...w });
      }
      for (const w of merged) {
        this.doc.setFont(font, w.bold ? "bold" : "normal");
        this.doc.setFontSize(size);
        this.doc.text(w.text, cx, base);
        cx += this.doc.getTextWidth(w.text);
      }
      this.y += lineH;
    });
  }

  heading(text: string, level: number): void {
    const size = level <= 1 ? 15 : level === 2 ? 13 : 11.5;
    this.gap(level <= 2 ? 10 : 6);
    this.room(size * PAGE.lead + PAGE.body * PAGE.lead * 3); // a heading keeps three lines of its text
    this.text([{ text, bold: true }], size);
    this.gap(2);
  }

  code(lines: string[]): void {
    const size = 8.5;
    const lineH = size * 1.35;
    this.gap(2);
    for (const raw of lines) {
      const safe = pdfSafe(raw) || " ";
      this.doc.setFont("courier", "normal");
      this.doc.setFontSize(size);
      for (const piece of this.doc.splitTextToSize(safe, this.width - 12) as string[]) {
        this.room(lineH);
        this.doc.setFillColor(244, 244, 246);
        this.doc.rect(PAGE.margin, this.y, this.width, lineH, "F");
        this.doc.setFont("courier", "normal");
        this.doc.setFontSize(size);
        this.doc.text(piece, PAGE.margin + 6, this.y + size);
        this.y += lineH;
      }
    }
    this.gap(4);
  }

  rule(): void {
    this.gap(4);
    this.room(8);
    this.doc.setDrawColor(200, 200, 205);
    this.doc.line(PAGE.margin, this.y, PAGE.margin + this.width, this.y);
    this.gap(8);
  }

  blocks(markdown: string): void {
    for (const b of specBlocks(markdown)) {
      if (b.kind === "h") this.heading(b.text, b.level);
      else if (b.kind === "p") {
        this.text(inlineRuns(b.text), PAGE.body);
        this.gap(4);
      } else if (b.kind === "ul" || b.kind === "ol") {
        b.lines.forEach((l, i) => this.text(inlineRuns(l), PAGE.body, { indent: 16, marker: b.kind === "ul" ? "•" : `${i + 1}.` }));
        this.gap(4);
      } else if (b.kind === "code") this.code(b.lines);
      else this.rule();
    }
  }
}

export interface SpecPdfInput {
  /** The conversation's title. */
  title: string;
  /** "Requirement" or "Fix plan". */
  kind: string;
  spec: string;
  when?: Date;
}

/** Lay the spec out on A4 pages and return the document; `downloadSpecPdf` saves it. */
export function specPdf(JsPDF: typeof import("jspdf").jsPDF, input: SpecPdfInput): { doc: Doc; fileName: string } {
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const { form, slug, files } = splitOpenSpec(input.spec);
  const when = (input.when ?? new Date()).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  doc.setProperties({ title: pdfSafe(input.title), subject: input.kind, creator: "Compass" });

  const w = new Writer(doc);
  doc.setTextColor(110, 110, 120);
  w.text([{ text: `${input.kind} · ${when}`, bold: false }], 9.5);
  doc.setTextColor(20, 20, 25);
  w.text([{ text: input.title, bold: true }], 19);
  w.gap(6);
  w.blocks(files.length ? form : input.spec);

  if (files.length) {
    w.rule();
    w.heading(slug ? `OpenSpec draft: ${slug}` : "OpenSpec draft", 1);
    for (const f of files) {
      w.gap(8);
      w.room(90); // the file name travels with the start of its content
      w.text([{ text: f.path, bold: true }], 11, { font: "courier" });
      w.gap(2);
      w.blocks(f.content);
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(130, 130, 140);
    const foot = doc.internal.pageSize.getHeight() - PAGE.margin / 2;
    doc.text(pdfSafe(input.title).slice(0, 90), PAGE.margin, foot);
    const n = `${p} / ${pages}`;
    doc.text(n, doc.internal.pageSize.getWidth() - PAGE.margin - doc.getTextWidth(n), foot);
  }
  doc.setTextColor(20, 20, 25);
  return { doc, fileName: pdfFileName(input.title, slug) };
}

export async function downloadSpecPdf(input: SpecPdfInput): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const { doc, fileName } = specPdf(jsPDF, input);
  doc.save(fileName);
}
