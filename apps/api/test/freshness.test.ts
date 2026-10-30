import { describe, expect, it } from "vitest";
import { freshnessOf } from "../src/routes/read.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.parse("2026-10-31T12:00:00Z");
const ago = (ms: number) => new Date(now - ms);

describe("freshnessOf", () => {
  it("is fresh hours after the nightly walk while webhooks are being processed", () => {
    // The old test (15 minutes since the walk) called this stale all day.
    expect(freshnessOf(ago(9 * HOUR), null, 15 * MIN, now)).toEqual({ stale: false, reason: null });
    expect(freshnessOf(ago(9 * HOUR), ago(2 * MIN), 15 * MIN, now).stale).toBe(false);
  });

  it("is behind when a webhook has sat unprocessed past the threshold", () => {
    expect(freshnessOf(ago(HOUR), ago(20 * MIN), 15 * MIN, now)).toEqual({ stale: true, reason: "webhooks-backed-up" });
  });

  it("is behind when the nightly walk was missed, or never ran", () => {
    expect(freshnessOf(ago(27 * HOUR), null, 15 * MIN, now)).toEqual({ stale: true, reason: "walk-missed" });
    expect(freshnessOf(null, null, 15 * MIN, now)).toEqual({ stale: true, reason: "never-synced" });
  });
});
