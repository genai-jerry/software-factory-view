/**
 * Shape writes a requirement as a factory requirement (the issue form's
 * sections) followed by a draft OpenSpec change: a `## OpenSpec change:
 * <slug>` heading and one four-backtick fence per file, its info string
 * `openspec <path>`. One text, so the person edits it in one box; this splits
 * it for the issue, where each file travels in its own fold for the Intake
 * Analyst to start the change folder from.
 */

export type OpenSpecFile = { path: string; content: string };
export type OpenSpecDraft = { form: string; slug: string | null; files: OpenSpecFile[] };

const FILE = /^````openspec[ \t]+(\S+)[ \t]*\n([\s\S]*?)\n````[ \t]*$/gm;
const HEADING = /^##[ \t]+OpenSpec change:[ \t]*`?([a-z0-9][a-z0-9-]*)`?[ \t]*$/im;

/** A path inside the change folder: relative, no `..`, ending in .md. */
function safePath(path: string): boolean {
  return /^[A-Za-z0-9_.\-/]+\.md$/.test(path) && !path.startsWith("/") && !path.split("/").includes("..");
}

export function splitOpenSpec(spec: string): OpenSpecDraft {
  const text = spec.replace(/\r\n/g, "\n");
  const files: OpenSpecFile[] = [];
  for (const m of text.matchAll(FILE)) {
    const path = m[1]!;
    if (safePath(path)) files.push({ path, content: m[2]!.trim() });
  }
  const heading = HEADING.exec(text);
  // The form is everything before the change: its heading, or its first file.
  const firstFile = text.search(/^````openspec[ \t]/m);
  const cut = heading ? heading.index : firstFile;
  const form = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return { form, slug: heading ? heading[1]!.toLowerCase() : null, files };
}

/**
 * The issue body for a requirement. A requirement without a draft (one
 * written before Shape spoke OpenSpec, or edited down to the form) goes in as
 * it is.
 */
export function requirementBody(spec: string): string {
  const { form, slug, files } = splitOpenSpec(spec);
  if (files.length === 0) return spec.trim();
  const folder = `openspec/changes/<this issue's number>-${slug ?? "<slug>"}/`;
  const folds = files.map((f) => `<details><summary><code>${f.path}</code></summary>\n\n\`\`\`\`markdown\n${f.content}\n\`\`\`\`\n</details>`);
  return [
    form,
    `## OpenSpec draft\n\nDrafted in Compass from the Shape conversation. The Intake Analyst starts the change folder \`${folder}\` from these files, checks them against the code and \`openspec/specs/\`, and opens them for approval at gate G1.\n\n<!-- openspec-draft: ${slug ?? ""} -->`,
    folds.join("\n\n"),
  ].join("\n\n");
}
