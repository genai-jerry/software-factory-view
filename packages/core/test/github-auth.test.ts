import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppAuth,
  ORCHESTRATOR_GITHUB_TOKEN_MIN_REMAINING_MS,
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
});
