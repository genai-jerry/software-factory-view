import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppAuth,
  GitHubHttpError,
  OAuthRefreshError,
  ORCHESTRATOR_GITHUB_TOKEN_MIN_REMAINING_MS,
  UserClient,
  installationTokenForOrchestrator,
} from "../src/github.js";

const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function auth() {
  return new AppAuth({
    apiUrl: "https://api.invalid",
    appId: "1",
    privateKeyPem: PKCS8,
    oauthClientId: "Iv1.x",
    oauthClientSecret: "s",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AppAuth.installationToken", () => {
  it("reuses a cached token that still has the requested remaining life", async () => {
    let minted = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      expect(String(url)).toContain("/app/installations/9/access_tokens");
      minted += 1;
      return new Response(
        JSON.stringify({
          token: `ghs_${minted}`,
          expires_at: new Date(Date.now() + 40 * 60_000).toISOString(),
        }),
        { status: 201 },
      );
    });

    const gh = auth();
    expect(await gh.installationToken(9)).toBe("ghs_1");
    expect(await gh.installationToken(9)).toBe("ghs_1");
    expect(minted).toBe(1);
  });

  it("mints a new token when the cache would not outlive a 45-minute role run", async () => {
    let minted = 0;
    vi.stubGlobal("fetch", async () => {
      minted += 1;
      const remainingMin = minted === 1 ? 40 : 60;
      return new Response(
        JSON.stringify({
          token: `ghs_${minted}`,
          expires_at: new Date(Date.now() + remainingMin * 60_000).toISOString(),
        }),
        { status: 201 },
      );
    });

    const gh = auth();
    expect(await gh.installationToken(9)).toBe("ghs_1");
    expect(await installationTokenForOrchestrator(gh, 9)).toBe("ghs_2");
    expect(minted).toBe(2);
    expect(ORCHESTRATOR_GITHUB_TOKEN_MIN_REMAINING_MS).toBe(50 * 60 * 1000);
  });

  it("mints a new token when forceFresh is set even if the cache is young", async () => {
    let minted = 0;
    vi.stubGlobal("fetch", async () => {
      minted += 1;
      return new Response(
        JSON.stringify({
          token: `ghs_${minted}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
        { status: 201 },
      );
    });
    const gh = auth();
    expect(await gh.installationToken(9)).toBe("ghs_1");
    expect((await gh.mintInstallationToken(9, { forceFresh: true })).token).toBe("ghs_2");
    expect(minted).toBe(2);
  });
});

describe("AppAuth OAuth grants", () => {
  it("keeps the refresh token and both expiries from the code exchange", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("https://github.test/login/oauth/access_token");
      expect(JSON.parse(String(init.body))).toMatchObject({ code: "abc", client_id: "Iv1.x" });
      return new Response(
        JSON.stringify({
          access_token: "ghu_1",
          expires_in: 28_800,
          refresh_token: "ghr_1",
          refresh_token_expires_in: 15_811_200,
        }),
        { status: 200 },
      );
    });

    const before = Date.now();
    const grant = await auth().exchangeOAuthCode("abc", "https://github.test");
    expect(grant.accessToken).toBe("ghu_1");
    expect(grant.refreshToken).toBe("ghr_1");
    expect(grant.expiresAt!).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(grant.refreshTokenExpiresAt!).toBeGreaterThanOrEqual(before + 15_811_200_000);
  });

  it("reports no expiry for an App that does not expire user tokens", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "ghu_1" }), { status: 200 }));
    const grant = await auth().exchangeOAuthCode("abc", "https://github.test");
    expect(grant.expiresAt).toBeNull();
    expect(grant.refreshToken).toBeNull();
  });

  it("trades a refresh token for a new grant", async () => {
    let body: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string | URL, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ access_token: "ghu_2", expires_in: 28_800, refresh_token: "ghr_2", refresh_token_expires_in: 100 }),
        { status: 200 },
      );
    });

    const grant = await auth().refreshOAuthToken("ghr_1", "https://github.test");
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_1", client_secret: "s" });
    // GitHub rotates the refresh token on use — the caller must store the new one.
    expect(grant).toMatchObject({ accessToken: "ghu_2", refreshToken: "ghr_2" });
  });

  it("flags a dead refresh token as needing re-authorization", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "bad_refresh_token", error_description: "expired" }), { status: 200 }),
    );
    const err = await auth()
      .refreshOAuthToken("ghr_old", "https://github.test")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).mustReauthorize).toBe(true);
  });

  it("does not ask for re-authorization when GitHub merely fell over", async () => {
    vi.stubGlobal("fetch", async () => new Response("upstream is down", { status: 502 }));
    const err = await auth()
      .refreshOAuthToken("ghr_1", "https://github.test")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).mustReauthorize).toBe(false);
  });
});

describe("RepoReader 401 handling", () => {
  it("retries once with a renewed token", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init: RequestInit) => {
      const token = String((init.headers as Record<string, string>).authorization);
      seen.push(token);
      return token.endsWith("fresh")
        ? new Response(JSON.stringify({ login: "alice" }), { status: 200 })
        : new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });

    let renewals = 0;
    const gh = new UserClient("https://api.invalid", async (opts) => {
      if (opts?.forceFresh) renewals += 1;
      return renewals > 0 ? "fresh" : "stale";
    });

    expect(await gh.me()).toMatchObject({ login: "alice" });
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(renewals).toBe(1);
  });

  it("lets the 401 stand when the provider cannot renew", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });

    const gh = new UserClient("https://api.invalid", "stale");
    const err = await gh.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubHttpError);
    expect((err as GitHubHttpError).status).toBe(401);
    // No second request: the provider handed back the same dead token.
    expect(calls).toBe(1);
  });
});
