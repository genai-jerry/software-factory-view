import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_MIN, PHONE_MAX } from "./lib/screens.js";

/*
 * Design D1 (epic #178): the stylesheet switches at the three screen sizes
 * only. A media query at any other width brings back the "which phone rule
 * applies here?" problem this epic removed.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("styles.css screen sizes", () => {
  it("uses only the phone, tablet and desktop widths in media queries", () => {
    const allowed = new Set([
      `max-width: ${PHONE_MAX}px`,
      `min-width: ${PHONE_MAX + 1}px`,
      `max-width: ${DESKTOP_MIN - 1}px`,
      `min-width: ${DESKTOP_MIN}px`,
    ]);
    const used = [...css.matchAll(/@media[^{]*\((m(?:in|ax)-width:\s*\d+px)\)/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((q) => !allowed.has(q))).toEqual([]);
  });

  it("carries the shared wrap-or-scroll classes and the 44px phone rule", () => {
    expect(css).toMatch(/\.scroll-x\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/--nav-h:\s*3\.5rem/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*button,[^{]*\{\s*min-height: var\(--target\);\s*min-width: var\(--target\);/);
  });
});
