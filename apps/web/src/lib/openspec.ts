/**
 * The requirement Shape writes is the factory requirement's form followed by
 * a draft OpenSpec change: `## OpenSpec change: <slug>` and one four-backtick
 * fence per file, info string `openspec <path>`. The API splits it the same
 * way for the issue (apps/api/src/openspec-draft.ts); this splits it to show.
 */
export type OpenSpecFile = { path: string; content: string };

const FILE = /^````openspec[ \t]+(\S+)[ \t]*\n([\s\S]*?)\n````[ \t]*$/gm;
const HEADING = /^##[ \t]+OpenSpec change:[ \t]*`?([a-z0-9][a-z0-9-]*)`?[ \t]*$/im;

export function splitOpenSpec(spec: string): { form: string; slug: string | null; files: OpenSpecFile[] } {
  const text = spec.replace(/\r\n/g, "\n");
  const files = [...text.matchAll(FILE)].map((m) => ({ path: m[1]!, content: m[2]!.trim() }));
  const heading = HEADING.exec(text);
  const cut = heading ? heading.index : text.search(/^````openspec[ \t]/m);
  return { form: (cut >= 0 ? text.slice(0, cut) : text).trim(), slug: heading ? heading[1]!.toLowerCase() : null, files };
}
