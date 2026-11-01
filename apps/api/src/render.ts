import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { rewriteGitHubMediaUrls } from "./media.js";

/**
 * Server-side markdown rendering. The SPA never renders raw markdown or
 * unsanitised HTML — everything it injects has passed through this filter
 * (plan 02 §1a "content security").
 */
/** `#21` or `owner/repo#21`, not part of a word, an entity (`&#39;`) or a path. */
const REF = /(?<![\w/&#;.-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/**
 * Turn issue and PR references in rendered HTML into links, so "read the
 * blocking comment on #21" can be clicked. A bare `#21` means the repo the
 * text came from; `owner/repo#21` names its own. GitHub's /issues/N address
 * redirects to /pull/N when N is a pull request, so one form serves both.
 * Text inside links, code and pre blocks is left alone.
 */
export function linkifyRefs(html: string, defaultRepo?: string): string {
  let skip = 0; // depth inside <a>, <code> or <pre>
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        const m = /^<(\/?)(a|code|pre)\b/i.exec(part);
        if (m) skip = Math.max(0, skip + (m[1] ? -1 : part.endsWith("/>") ? 0 : 1));
        return part;
      }
      if (skip > 0) return part;
      return part.replace(REF, (whole, repo: string | undefined, n: string) => {
        const target = repo ?? defaultRepo;
        if (!target) return whole;
        return `<a href="https://github.com/${target}/issues/${n}" target="_blank" rel="noopener noreferrer">${whole}</a>`;
      });
    })
    .join("");
}

/**
 * A Mermaid `graph` / `flowchart` written for people — a task tree, a
 * case-to-task map — reaches the user view as an ordered list of chains
 * ("aggregation → endpoint → panel") instead of a code block nobody can
 * read. Node labels are cleaned the way the factory writes them: `<br/>`
 * segments that are only an issue reference (`beacon-api#62`, `#62`), a
 * `T<n>` id or a bare number are dropped, and a leading ordinal goes.
 * Other diagram types are left as the code block they were.
 */
const ARROW = /\s*(?:-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|-\.+-)\s*(?:\|[^|]*\|\s*)?/;
const NODE = /^\s*([\w.-]+)\s*(?:(?:\[\[|\[\(|\(\(|\(\[|\{\{|[[({>])\s*(.*?)\s*(?:\]\]|\)\]|\)\)|\]\)|\}\}|[\])}])\s*)?(?::::\w+)?\s*$/;
const NOISE = /^\s*(?:(?:[\w.-]+(?:\/[\w.-]+)?)?#\d+|T\d+|\d+)\s*$/i;

function cleanLabel(raw: string, id: string): string {
  const parts = raw
    .replace(/^"(.*)"$/, "$1")
    .split(/<br\s*\/?>/i)
    .map((p) => p.replace(/^"|"$/g, "").trim())
    .filter((p) => p && !NOISE.test(p))
    .map((p) => p.replace(/^\d+[.)]?\s+/, ""));
  return parts.join(" · ") || id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mermaidToChains(source: string): string | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  const head = lines.find((l) => l) ?? "";
  if (!/^(?:graph|flowchart)\b/i.test(head)) return null;
  const labels = new Map<string, string>();
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  const seen: string[] = [];
  const node = (seg: string): string | null => {
    const m = NODE.exec(seg);
    if (!m) return null;
    const id = m[1]!;
    if (!labels.has(id)) {
      labels.set(id, m[2] !== undefined ? cleanLabel(m[2], id) : id);
      seen.push(id);
    } else if (m[2] !== undefined && labels.get(id) === id) {
      labels.set(id, cleanLabel(m[2], id));
    }
    return id;
  };
  for (const line of lines.slice(lines.indexOf(head) + 1)) {
    if (!line || /^(?:%%|subgraph\b|end$|style\b|classDef\b|class\b|linkStyle\b|click\b|direction\b)/i.test(line)) continue;
    for (const stmt of line.split(/\s*&\s*|;/)) {
      const ids = stmt.split(ARROW).map(node);
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = ids[i];
        const b = ids[i + 1];
        if (!a || !b) continue;
        const nexts = out.get(a) ?? [];
        if (!nexts.includes(b)) {
          nexts.push(b);
          out.set(a, nexts);
          indeg.set(b, (indeg.get(b) ?? 0) + 1);
        }
      }
    }
  }
  if (seen.length === 0) return null;
  const chains: string[][] = [];
  const walk = (id: string, path: string[]) => {
    if (path.includes(id) || chains.length >= 50) return;
    const next = out.get(id) ?? [];
    if (next.length === 0) chains.push([...path, id]);
    for (const n of next) walk(n, [...path, id]);
  };
  for (const id of seen) if (!(indeg.get(id) ?? 0) && (out.get(id) ?? []).length > 0) walk(id, []);
  const alone = seen.filter((id) => !(indeg.get(id) ?? 0) && (out.get(id) ?? []).length === 0);
  const name = (id: string) => escapeHtml(labels.get(id) ?? id);
  let html = "";
  if (chains.length > 0) html += `<ol class="chain">${chains.map((c) => `<li>${c.map(name).join(" → ")}</li>`).join("")}</ol>`;
  if (alone.length > 0) html += `<p class="chain-alone">On their own: ${alone.map(name).join(", ")}</p>`;
  return html;
}

/** Replace readable Mermaid fences with their chain list before markdown runs. */
function readableDiagrams(md: string): string {
  return md.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const html = mermaidToChains(body);
    return html ? `\n\n${html}\n\n` : whole;
  });
}

export function renderMarkdown(md: string, opts?: { repoId?: string; repoFullName?: string; issueNumber?: number | null }): string {
  const html = marked.parse(readableDiagrams(md), { async: false, gfm: true }) as string;
  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "details", "summary", "input"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title", "width", "height"],
      input: ["type", "checked", "disabled"],
      a: ["href", "name", "target", "rel"],
      code: ["class"],
      span: ["class"],
      ol: ["class"],
      p: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
  const linked = linkifyRefs(sanitized, opts?.repoFullName);
  return opts?.repoId ? rewriteGitHubMediaUrls(linked, opts.repoId, opts.issueNumber) : linked;
}
