import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * Server-side markdown rendering. The SPA never renders raw markdown or
 * unsanitised HTML — everything it injects has passed through this filter
 * (plan 02 §1a "content security").
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true }) as string;
  return sanitizeHtml(html, {
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
}
