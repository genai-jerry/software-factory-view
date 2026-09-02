import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api.js";
import { useReauthNeeded } from "./lib/reauth.js";

/**
 * A 401 the API marks `reauth` means it tried to renew the GitHub grant and
 * GitHub refused — the one case a human must act on. It has to be told apart
 * from a plain 401 (no session), which the app answers with the front door.
 */

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiError.needsReauth", () => {
  it("is set only for a 401 the API flagged as needing re-authorization", () => {
    expect(new ApiError(401, "expired", { error: "expired", reauth: true }).needsReauth).toBe(true);
    expect(new ApiError(401, "not signed in", { error: "not signed in" }).needsReauth).toBe(false);
    expect(new ApiError(403, "no", { error: "no", reauth: true }).needsReauth).toBe(false);
    expect(new ApiError(500, "boom", null).needsReauth).toBe(false);
  });
});

describe("the fetch wrapper", () => {
  // The flag is module state and deliberately sticky, so this case runs first.
  it("leaves the re-auth banner down for an ordinary failure", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(403, { error: "GitHub declined to comment" }));

    await expect(api.post("/api/epics/1/gate/approve")).rejects.toBeInstanceOf(ApiError);
    expect(renderHook(() => useReauthNeeded()).result.current).toBe(false);
  });

  it("raises the re-auth banner when the API says the grant is beyond renewal", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(401, { error: "GitHub sign-in has expired (bad_refresh_token) — sign in again", reauth: true }),
    );

    const err = await api.post("/api/epics/1/gate/approve").catch((e: unknown) => e);
    expect((err as ApiError).needsReauth).toBe(true);
    // What App.tsx renders the "Sign in again" banner from.
    expect(renderHook(() => useReauthNeeded()).result.current).toBe(true);
  });
});
