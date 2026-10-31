/**
 * Read a system test plan (`system-tests/test-plan.md`, FACTORY.md §4b) into
 * what a tester needs on the Test board: the environment to stand up, and
 * for each case its preconditions, steps and expected result.
 *
 * The plan is Markdown the Test Planner writes in one fixed shape:
 *
 *     ## Environment
 *     …prose and a | Needs | Detail | table…
 *     ## Test cases
 *     ### ST-1: A lead's CRM calling status reaches the leads page
 *     - `Covers:` …
 *     - `Depends on:` 3, 4
 *     - `Preconditions:` …
 *     - `Steps:`
 *       1. …
 *       2. …
 *     - `Expected:` …
 *
 * Nothing here is clever: the case id in the heading is the join to the
 * case issue (`test(35): ST-1 …`), and the labelled bullets are read by name.
 * A plan that strays from the shape still yields what it can; a case the
 * parser cannot read shows no steps rather than wrong ones.
 */

export interface PlanCase {
  id: string;
  title: string;
  preconditions: string | null;
  steps: string[];
  expected: string | null;
  data: string | null;
  execution: string | null;
  dependsOn: string | null;
}

export interface PlanEnvironment {
  /** Paragraphs before and after the table, in order. */
  notes: string[];
  /** The `| Needs | Detail |` rows. */
  rows: Array<[string, string]>;
}

export interface TestPlan {
  title: string | null;
  environment: PlanEnvironment | null;
  cases: Map<string, PlanCase>;
}

const CASE_HEADING = /^###\s+((?:ST|TC)-\d+)\s*[:.]?\s*(.*)$/;
const LABEL = /^-\s+`([A-Za-z ]+):`\s*(.*)$/;
const STEP = /^\s+\d+\.\s+(.*)$/;

export function parseTestPlan(markdown: string): TestPlan {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title: string | null = null;
  const cases = new Map<string, PlanCase>();
  let environment: PlanEnvironment | null = null;

  let section: "none" | "environment" | "cases" = "none";
  let current: PlanCase | null = null;
  let field: keyof PlanCase | null = null;
  const envLines: string[] = [];

  const finish = () => {
    if (current) cases.set(current.id, current);
    current = null;
    field = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ") && title === null) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      finish();
      const name = line.slice(3).trim().toLowerCase();
      section = name === "environment" ? "environment" : name.startsWith("test case") ? "cases" : "none";
      continue;
    }
    if (section === "environment") {
      envLines.push(line);
      continue;
    }
    if (section !== "cases") continue;

    const heading = CASE_HEADING.exec(line);
    if (heading) {
      finish();
      current = { id: heading[1]!, title: heading[2]!.trim(), preconditions: null, steps: [], expected: null, data: null, execution: null, dependsOn: null };
      continue;
    }
    if (!current) continue;

    const label = LABEL.exec(line);
    if (label) {
      const key = label[1]!.toLowerCase();
      const value = label[2]!.trim();
      field = null;
      if (key === "steps") field = "steps";
      else if (key === "preconditions") current.preconditions = value || null;
      else if (key === "expected") {
        current.expected = value || null;
        field = "expected";
      } else if (key === "data") current.data = value || null;
      else if (key === "execution") current.execution = value || null;
      else if (key === "depends on") current.dependsOn = value || null;
      continue;
    }
    if (field === "steps") {
      const step = STEP.exec(line);
      if (step) {
        current.steps.push(step[1]!.trim());
        continue;
      }
      if (line.trim() === "") continue;
      // A wrapped step line continues the previous step.
      if (/^\s+\S/.test(line) && current.steps.length > 0) {
        current.steps[current.steps.length - 1] += ` ${line.trim()}`;
        continue;
      }
      field = null;
    }
    if (field === "expected" && /^\s+\S/.test(line) && current.expected) {
      current.expected += ` ${line.trim()}`;
    }
  }
  finish();

  if (envLines.length > 0) environment = parseEnvironment(envLines);
  return { title, environment, cases };
}

function parseEnvironment(lines: string[]): PlanEnvironment {
  const notes: string[] = [];
  const rows: Array<[string, string]> = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) notes.push(para.join(" "));
    para = [];
  };
  for (const line of lines) {
    if (line.startsWith("|")) {
      flush();
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 2 || cells.every((c) => /^-+$/.test(c))) continue;
      if (rows.length === 0 && /^needs$/i.test(cells[0]!)) continue; // the header row
      rows.push([cells[0]!, cells.slice(1).join(" ")]);
      continue;
    }
    if (line.trim() === "" || line.startsWith("###")) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { notes, rows };
}

/** The case id a case issue's title carries: `test(35): ST-14 …` → `ST-14`. */
export function caseIdOf(title: string, caseId: string | null): string | null {
  if (caseId) return caseId;
  const m = /\b((?:ST|TC)-\d+)\b/.exec(title);
  return m ? m[1]! : null;
}

/** Plain words from a plan line: backticks and bold markers dropped, links reduced to their text. */
export function plain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
