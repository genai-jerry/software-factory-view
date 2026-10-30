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

export function renderMarkdown(md: string, opts?: { repoId?: string; repoFullName?: string }): string {
  const html = marked.parse(md, { async: false, gfm: true }) as string;
  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "details", "summary", "input"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title", "width", "height"],
      input: ["type", "checked", "disabled"],
      a: ["href", "name", "target", "rel"],
      code: ["class"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
  const linked = linkifyRefs(sanitized, opts?.repoFullName);
  return opts?.repoId ? rewriteGitHubMediaUrls(linked, opts.repoId) : linked;
}
