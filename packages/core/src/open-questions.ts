/**
 * Design docs close with a numbered `## Open Questions` list and, where a
 * question is scoped to part of the design, an "Open questions by area"
 * table right after it (architect.md step 3): `| Area | Item | Questions |`,
 * naming which numbered question(s) apply to which area. This is what lets
 * the gate G2 panel tell a reviewer *which* part of the design still has
 * open questions instead of a bare thread-entry count.
 */

export interface OpenQuestionArea {
  area: string;
  item: string;
  questionNumbers: string[];
}

const OPEN_QUESTIONS_HEADING_RE = /^##[ \t]+Open Questions[ \t]*$/im;
const NEXT_HEADING_RE = /^##[ \t]+/m;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const SEPARATOR_CELL_RE = /^:?-+:?$/;

/** Parse the "Open questions by area" table out of a design.md's Open Questions section, if present. */
export function parseOpenQuestionAreas(markdown: string): OpenQuestionArea[] {
  const heading = markdown.match(OPEN_QUESTIONS_HEADING_RE);
  if (!heading) return [];
  const afterHeading = markdown.slice(heading.index! + heading[0].length);
  const nextHeading = afterHeading.match(NEXT_HEADING_RE);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;

  const tableLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (tableLines.length < 2) return [];

  const header = splitRow(tableLines[0]!);
  const areaIdx = header.findIndex((h) => /area/i.test(h));
  const itemIdx = header.findIndex((h) => /item/i.test(h));
  const questionsIdx = header.findIndex((h) => /question/i.test(h));
  if (areaIdx < 0 || itemIdx < 0 || questionsIdx < 0) return [];

  const out: OpenQuestionArea[] = [];
  for (const line of tableLines.slice(1)) {
    const cells = splitRow(line);
    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue; // header separator row
    const area = cells[areaIdx];
    const item = cells[itemIdx];
    const questions = cells[questionsIdx];
    if (!area || !item || !questions) continue;
    const questionNumbers = questions
      .split(",")
      .map((q) => q.trim())
      .filter(Boolean);
    if (questionNumbers.length === 0) continue;
    out.push({ area, item, questionNumbers });
  }
  return out;
}
