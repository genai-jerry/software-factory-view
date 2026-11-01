/**
 * The questions a blocking comment asks (FACTORY.md §1a rule 13): the list
 * under `**Questions for you:**`, or — for a comment written before that
 * rule — its lines that end in a question mark, fold excluded. The same
 * reading as the factory's hand-off notice makes, so the thread and the
 * notice show one list.
 */

const HEAD = /^\s*\**questions? for you:?\**\s*(.*)$/i;
const ITEM = /^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/;
const LEAD = /^\s*(?:\d+[.)]|[-*])\s+/;
export const MAX_QUESTIONS = 8;
export const AGENT_MARK = "<!-- factory-agent -->";
export const NEXT_MARK = "factory-next:";

/** A comment without its fold, its markers and its code: what a person reads. */
export function visiblePart(body: string | null | undefined): string {
  return (body ?? "")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

export function extractQuestions(body: string | null | undefined, limit = MAX_QUESTIONS): string[] {
  const lines = visiblePart(body).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i]!);
    if (!m) continue;
    const out: string[] = [];
    const first = (m[1] ?? "").trim().replace(/^\*+|\*+$/g, "").trim();
    if (first) out.push(first.replace(LEAD, ""));
    for (const rest of lines.slice(i + 1)) {
      const item = ITEM.exec(rest);
      if (item) out.push(item[1]!.trim());
      else if (rest.trim() === "") {
        if (out.length) break;
      } else break;
    }
    if (out.length) return out.slice(0, limit);
  }
  const out: string[] = [];
  for (const line of lines) {
    const s = line.replace(LEAD, "").trim().replace(/^\*+|\*+$/g, "").trim();
    if (s.endsWith("?") && s.length >= 8 && s.length <= 300 && !out.includes(s)) out.push(s);
  }
  return out.slice(0, limit);
}

/** Whether an agent comment is a role's own word, not a hand-off notice or a run-started line. */
export function isRoleComment(body: string | null | undefined): boolean {
  const b = body ?? "";
  if (!b.includes(AGENT_MARK) || b.includes(NEXT_MARK)) return false;
  return !visiblePart(b).trim().startsWith("▶");
}
