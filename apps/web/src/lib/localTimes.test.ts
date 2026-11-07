import { beforeAll, describe, expect, it } from "vitest";
import { localTimesHtml, localTimesText, timePieces } from "./localTimes.js";

// The reader is in India, five and a half hours east of UTC.
beforeAll(() => {
  process.env.TZ = "Asia/Kolkata";
});

const at = (iso: string) => new Date(iso);
const t = (h: number, m: number) => new Date(2026, 10, 6, h, m).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("localTimesText", () => {
  const written = at("2026-11-06T09:14:00Z"); // 14:44 in India

  it("shows a UTC clock time in the reader's time", () => {
    expect(localTimesText("failed at 04:44 UTC and again", written)).toBe(`failed at ${t(10, 14)} and again`);
    expect(localTimesText("tests ran 01:47–01:51 UTC.", written)).toBe(`tests ran ${t(7, 17)}–${t(7, 21)}.`);
    expect(localTimesText("resets 2:50pm (UTC)", at("2026-11-06T14:43:00Z"))).toBe(`resets ${t(20, 20)}`);
  });

  it("reads ISO timestamps with a zone, and says the date when it is another day", () => {
    expect(localTimesText("merged 2026-11-06T02:10:00Z", written)).toBe(`merged ${t(7, 40)}`);
    expect(localTimesText("at 2026-11-05 13:44 UTC", written)).toMatch(/^at (5 Nov|Nov 5), /);
  });

  it("takes a bare time's day from when it was written, nearest either way", () => {
    // written at 01:00 UTC, about 22:00 UTC: that was the evening before
    const late = localTimesText("ran at 22:00 UTC", at("2026-11-06T01:00:00Z"));
    expect(late).toBe(`ran at ${new Date("2026-11-06T03:30:00+05:30").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  });

  it("leaves a time that names no zone, and plain numbers, alone", () => {
    const text = "failed at 04:44 (wall-clock exceeded 2700s), 2356 passed, ratio 3:1";
    expect(localTimesText(text, written)).toBe(text);
  });

  it("keeps the original for the tooltip", () => {
    const [, piece] = timePieces("at 04:44 UTC", written);
    expect(piece).toMatchObject({ original: "04:44 UTC", iso: "2026-11-06T04:44:00.000Z" });
  });
});

describe("localTimesHtml", () => {
  it("wraps converted times in <time>, and leaves code as written", () => {
    const html = "<p>Ran 01:47–01:51 UTC.</p><pre><code>started 01:47 UTC</code></pre>";
    const out = localTimesHtml(html, "2026-11-06T09:14:00Z");
    expect(out).toContain(`<time datetime="2026-11-06T01:47:00.000Z" title="01:47–01:51 UTC">${t(7, 17)}–${t(7, 21)}</time>`);
    expect(out).toContain("<code>started 01:47 UTC</code>");
  });

  it("returns HTML with no UTC time unchanged", () => {
    const html = "<p>Nothing to convert at 04:44.</p>";
    expect(localTimesHtml(html, "2026-11-06T09:14:00Z")).toBe(html);
  });
});
