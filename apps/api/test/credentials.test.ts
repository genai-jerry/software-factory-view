import { randomBytes } from "node:crypto";
import { CredentialStore, buildAppManifest, encryptSecret, toPkcs8 } from "@console/core";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

const KEY = randomBytes(32).toString("base64");
const PKCS1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const EMPTY_ENV = { appId: "", privateKeyPem: "", webhookSecret: "", clientId: "", clientSecret: "" };

describe("credential resolution", () => {
  it("is unconfigured when neither a row nor env credentials exist", async () => {
    const store = new CredentialStore({ masterKey: KEY, apiUrl: "https://api.invalid", load: async () => null, env: EMPTY_ENV });
    expect(await store.isConfigured()).toBe(false);
    expect(await store.auth()).toBeNull();
    await expect(store.requireAuth()).rejects.toThrow(/GITHUB_APP_/);
  });

  it("falls back to environment credentials when no row exists", async () => {
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "pem", webhookSecret: "whsec", clientId: "cid", clientSecret: "csec" },
    });
    const resolved = await store.resolve();
    expect(resolved?.source).toBe("environment");
    expect(await store.webhookSecret()).toBe("whsec");
  });

  it("returns a stored slug without calling GitHub, and null when env credentials omit one", async () => {
    const stored = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => ({
        appId: "1",
        slug: "factory-console",
        encryptedPrivateKey: encryptSecret("pem", KEY),
        encryptedWebhookSecret: encryptSecret("s", KEY),
        clientId: "c",
        encryptedClientSecret: encryptSecret("cs", KEY),
      }),
      env: EMPTY_ENV,
    });
    expect(await stored.resolveSlug()).toBe("factory-console");

    const fromEnv = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "pem", webhookSecret: "whsec", clientId: "cid", clientSecret: "csec" },
    });
    // GET /app against api.invalid fails; we must not throw — the install link is just absent.
    expect(await fromEnv.resolveSlug()).toBeNull();
  });

  it("prefers the stored row over the environment, and decrypts it", async () => {
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => ({
        appId: "999",
        slug: "factory-console",
        encryptedPrivateKey: encryptSecret("stored-pem", KEY),
        encryptedWebhookSecret: encryptSecret("stored-secret", KEY),
        clientId: "stored-client",
        encryptedClientSecret: encryptSecret("stored-client-secret", KEY),
      }),
      env: { appId: "1", privateKeyPem: "pem", webhookSecret: "whsec", clientId: "cid", clientSecret: "csec" },
    });
    const resolved = await store.resolve();
    expect(resolved?.source).toBe("database");
    expect(resolved?.appId).toBe("999");
    expect(resolved?.privateKeyPem).toBe("stored-pem");
    expect(await store.webhookSecret()).toBe("stored-secret");
  });

  it("picks up credentials registered after boot without a restart", async () => {
    // "Unconfigured" is deliberately not cached, so a process that started
    // before setup ran resolves the App on its next call.
    let row: StoredRow | null = null;
    const store = new CredentialStore({ masterKey: KEY, apiUrl: "https://api.invalid", load: async () => row, env: EMPTY_ENV });
    expect(await store.isConfigured()).toBe(false);

    row = {
      appId: "42",
      slug: "late",
      encryptedPrivateKey: encryptSecret("pem", KEY),
      encryptedWebhookSecret: encryptSecret("s", KEY),
      clientId: "c",
      encryptedClientSecret: encryptSecret("cs", KEY),
    };
    expect(await store.isConfigured()).toBe(true);
    expect((await store.resolve())?.appId).toBe("42");
  });

  it("reports a row it cannot decrypt as unconfigured instead of throwing", async () => {
    // The Console must stay up: environment secrets can still sign people in,
    // and crashing at boot would take Settings down with it.
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => ({
        appId: "999",
        slug: "broken",
        encryptedPrivateKey: "not-a-sealed-secret",
        encryptedWebhookSecret: encryptSecret("s", KEY),
        clientId: "c",
        encryptedClientSecret: encryptSecret("cs", KEY),
      }),
      env: EMPTY_ENV,
    });

    expect(await store.resolve()).toBeNull();
    expect(store.credentialError).toMatch(/cannot be decrypted/);
    expect(store.credentialError).toMatch(/CONSOLE_MASTER_KEY/);
    await expect(store.requireAuth()).rejects.toThrow(/cannot be decrypted/);
  });

  it("reports a row sealed under a different master key the same way", async () => {
    const otherKey = randomBytes(32).toString("base64");
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => ({
        appId: "999",
        slug: "rotated",
        encryptedPrivateKey: encryptSecret("stored-pem", otherKey),
        encryptedWebhookSecret: encryptSecret("s", otherKey),
        clientId: "c",
        encryptedClientSecret: encryptSecret("cs", otherKey),
      }),
      env: EMPTY_ENV,
    });

    expect(await store.resolve()).toBeNull();
    expect(store.credentialError).toMatch(/cannot be decrypted/);
  });

  it("falls back to environment credentials when the stored row is unreadable", async () => {
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => ({
        appId: "999",
        slug: "broken",
        encryptedPrivateKey: "garbage",
        encryptedWebhookSecret: "garbage",
        clientId: "c",
        encryptedClientSecret: "garbage",
      }),
      env: { appId: "1", privateKeyPem: "pem", webhookSecret: "whsec", clientId: "cid", clientSecret: "csec" },
    });
    expect((await store.resolve())?.source).toBe("environment");
    expect(store.credentialError).toMatch(/cannot be decrypted/);
  });

  it("caches a resolved App, and invalidate() forces a re-read", async () => {
    let row: StoredRow = {
      appId: "1",
      slug: "first",
      encryptedPrivateKey: encryptSecret("pem", KEY),
      encryptedWebhookSecret: encryptSecret("s", KEY),
      clientId: "c",
      encryptedClientSecret: encryptSecret("cs", KEY),
    };
    let reads = 0;
    const store = new CredentialStore({
      masterKey: KEY,
      apiUrl: "https://api.invalid",
      load: async () => {
        reads++;
        return row;
      },
      env: EMPTY_ENV,
    });
    await store.resolve();
    await store.resolve();
    expect(reads).toBe(1); // cached

    row = { ...row, appId: "2", slug: "second" };
    expect((await store.resolve())?.appId).toBe("1"); // still the cached one
    store.invalidate();
    expect((await store.resolve())?.appId).toBe("2");
  });
});

interface StoredRow {
  appId: string;
  slug: string | null;
  encryptedPrivateKey: string;
  encryptedWebhookSecret: string;
  clientId: string;
  encryptedClientSecret: string;
}

describe("App manifest", () => {
  it("points every URL at the configured public origin", () => {
    const m = buildAppManifest("https://console.example.com", "Factory Console") as Record<string, never>;
    expect((m["hook_attributes"] as unknown as { url: string }).url).toBe("https://console.example.com/webhooks/github");
    expect(m["redirect_url"]).toBe("https://console.example.com/setup/github-app/callback");
    expect(m["callback_urls"]).toEqual(["https://console.example.com/auth/github/callback"]);
    expect(m["setup_url"]).toBe("https://console.example.com/setup/install");
    expect(m["setup_on_update"]).toBe(true);
  });

  it("is public so any GitHub user can sign in (private Apps 404 on authorize)", () => {
    expect(buildAppManifest("https://x.test", "n")["public"]).toBe(true);
  });

  it("requests exactly the permissions the Console uses", () => {
    const m = buildAppManifest("https://x.test", "n") as Record<string, never>;
    expect(m["default_permissions"]).toEqual({
      issues: "write",
      pull_requests: "write",
      contents: "write",
      actions: "read",
      checks: "read",
      workflows: "read",
      secrets: "write",
      members: "read",
      metadata: "read",
    });
  });

  it("subscribes to the events the projections need", () => {
    const events = buildAppManifest("https://x.test", "n")["default_events"] as string[];
    for (const e of ["issues", "issue_comment", "pull_request", "workflow_run", "installation", "push"]) {
      expect(events).toContain(e);
    }
  });
});

describe("private key normalisation", () => {
  it("converts GitHub's PKCS#1 key to the PKCS#8 that JWT signing needs", async () => {
    expect(PKCS1).toContain("BEGIN RSA PRIVATE KEY");
    const converted = await toPkcs8(PKCS1);
    expect(converted).toContain("BEGIN PRIVATE KEY");
  });

  it("leaves an already-PKCS#8 key alone", async () => {
    const pkcs8 = await toPkcs8(PKCS1);
    expect(await toPkcs8(pkcs8)).toBe(pkcs8);
  });
});
