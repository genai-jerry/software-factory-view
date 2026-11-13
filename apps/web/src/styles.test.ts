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

  it("never lets a phone or tablet grid column grow wider than the screen", () => {
    // A bare 1fr track is minmax(auto, 1fr): its column will not shrink below
    // its longest word or widest pre, so the page grows sideways. Every grid
    // a width query re-lays uses minmax(0, 1fr) instead (design, wrap or scroll rule).
    const bare: string[] = [];
    for (const m of css.matchAll(/@media[^{]*\(m(?:in|ax)-width:\s*\d+px\)[^{]*\{/g)) {
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < css.length; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      const block = css.slice(m.index!, end);
      for (const g of block.matchAll(/grid-template-columns:([^;}]*)/g)) {
        if (/(^|[\s,])1fr\b/.test(g[1]!.replace(/minmax\([^)]*\)/g, ""))) bare.push(g[0].trim());
      }
    }
    expect(bare).toEqual([]);
  });

  it("carries the shared wrap-or-scroll classes and the 44px phone rule", () => {
    expect(css).toMatch(/\.scroll-x\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/--nav-h:\s*3\.5rem/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*button,[^{]*\{\s*min-height: var\(--target\);\s*min-width: var\(--target\);/);
  });
});
