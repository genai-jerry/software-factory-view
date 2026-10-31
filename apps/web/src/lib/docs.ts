/**
 * Read the factory's change documents (proposal.md, design.md, specs/*.md)
 * into the pieces the Clarify and Design boards show: a document's sections,
 * the bullet items under one of them, and a spec's scenarios.
 *
 * The documents are Markdown in the shapes the Intake Analyst, Architect and
 * Test Planner write. The boards read by heading and by bullet; a document
 * that strays yields less, never something wrong.
 */

export interface DocSection {
  level: number;
  title: string;
  /** The lines between this heading and the next, trimmed of surrounding blanks. */
  lines: string[];
}

export function sections(markdown: string): DocSection[] {
  const out: DocSection[] = [];
  let current: DocSection | null = null;
  let inCode = false;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) inCode = !inCode;
    const h = !inCode ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (h) {
      current = { level: h[1]!.length, title: h[2]!.trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  for (const s of out) {
    while (s.lines.length && s.lines[0]!.trim() === "") s.lines.shift();
    while (s.lines.length && s.lines[s.lines.length - 1]!.trim() === "") s.lines.pop();
  }
  return out;
}

/** The section whose title starts with any of the given words, case-insensitively. */
export function findSection(all: DocSection[], ...starts: string[]): DocSection | undefined {
  const lower = starts.map((s) => s.toLowerCase());
  return all.find((s) => lower.some((w) => s.title.toLowerCase().startsWith(w)));
}

/** Top-level bullet items of a section, wrapped lines joined, sub-bullets dropped. */
export function bullets(section: DocSection | undefined): string[] {
  if (!section) return [];
  const items: string[] = [];
  let inCode = false;
  for (const line of section.lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const top = /^[-*]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    if (top) {
      items.push(top[1]!.trim());
      continue;
    }
    if (/^\s+\S/.test(line) && items.length > 0 && !/^\s+[-*]\s/.test(line) && !/^\s+\d+\.\s/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  return items;
}

/** Prose paragraphs of a section, bullets and tables left out. */
export function paragraphs(section: DocSection | undefined, max = 3): string[] {
  if (!section) return [];
  const out: string[] = [];
  let buf: string[] = [];
  let inCode = false;
  const flush = () => {
    if (buf.length) out.push(buf.join(" "));
    buf = [];
  };
  for (const line of section.lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const t = line.trim();
    if (t === "") {
      flush();
      if (out.length >= max) break;
      continue;
    }
    if (/^([-*]|\d+\.)\s/.test(t) || t.startsWith("|") || t.startsWith(">")) {
      flush();
      continue;
    }
    buf.push(t);
  }
  flush();
  return out.slice(0, max);
}

/** A spec's scenario titles, in order: `#### Scenario: A quiet day still appears`. */
export function scenarios(markdown: string): string[] {
  return sections(markdown)
    .filter((s) => /^scenario:/i.test(s.title))
    .map((s) => s.title.replace(/^scenario:\s*/i, "").trim());
}

/**
 * The design document's decisions and its build order. The Architect writes
 * one `## Task n — title (#issue)` section per task and the rest of the
 * level-2 sections are the choices the design makes; each becomes D1…Dn.
 */
export function designParts(markdown: string): {
  decisions: Array<{ id: string; title: string; why: string[] }>;
  tasks: Array<{ n: number; title: string; issue: number | null; after: number[] }>;
} {
  const all = sections(markdown).filter((s) => s.level === 2);
  const decisions: Array<{ id: string; title: string; why: string[] }> = [];
  const tasks: Array<{ n: number; title: string; issue: number | null; after: number[] }> = [];
  for (const s of all) {
    const t = /^task\s+(\d+)\s*[—–:-]\s*(.*?)(?:\s*\(#(\d+)\))?\s*$/i.exec(s.title);
    if (t) {
      const body = s.lines.join(" ");
      const dep = /(?:depends on|after)\s+task[s]?\s+((?:\d+(?:\s*,\s*|\s+and\s+)?)+)/i.exec(body);
      const after = dep ? [...dep[1]!.matchAll(/\d+/g)].map((m) => Number(m[0])) : [];
      tasks.push({ n: Number(t[1]), title: t[2]!.trim(), issue: t[3] ? Number(t[3]) : null, after });
      continue;
    }
    if (/^(what this repo builds|rollout|shared contract|what the system test plan)/i.test(s.title)) continue;
    decisions.push({ id: `D${decisions.length + 1}`, title: s.title, why: paragraphs(s, 2) });
  }
  return { decisions, tasks };
}
