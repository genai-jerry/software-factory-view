import { randomBytes } from "node:crypto";
import { encryptSecret, loadConfig, AppAuth } from "@console/core";
import { orchestratorSecrets, orgs, webhookDeliveries } from "@console/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processWebhook, type WebhookJob } from "../src/ingest.js";
import { testDb } from "./helpers.js";

const auth = new AppAuth({ apiUrl: "https://api.invalid", appId: "", privateKeyPem: "", oauthClientId: "", oauthClientSecret: "" });

const REPO = {
  node_id: "R_fwd1",
  full_name: "acme/insurance-app-base",
  default_branch: "main",
  private: true,
};
const INSTALLATION = { id: 777 };

function job(event: string, payload: Record<string, unknown>, guid: string): WebhookJob {
  return { deliveryGuid: guid, event, payload };
}

async function ledgerInsert(db: Awaited<ReturnType<typeof testDb>>["db"], item: WebhookJob): Promise<void> {
  await db.insert(webhookDeliveries).values({ deliveryGuid: item.deliveryGuid, event: item.event }).onConflictDoNothing();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("orchestrator event forward", () => {
  it("does not forward when the org uses GitHub Actions", async () => {
    const { db } = await testDb();
    const cfg = loadConfig({
      CONSOLE_MASTER_KEY: "",
      ORCHESTRATOR_URL: "http://127.0.0.1:8080",
      ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
    } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const install = job("installation", {
      action: "created",
      installation: { id: INSTALLATION.id, account: { login: "acme" } },
      repositories: [{ node_id: REPO.node_id, full_name: REPO.full_name }],
    }, "fwd-install");
    await ledgerInsert(db, install);
    await processWebhook(db, cfg, auth, install);

    const opened = job("issues", {
      action: "opened",
      issue: {
        id: 102,
        node_id: "I_102",
        number: 102,
        title: "Add a FACTORY_CANARY.md",
        state: "open",
        body: "canary",
        user: { login: "jerry" },
        labels: [{ name: "factory:fast-track" }],
        created_at: "2026-08-24T10:00:00Z",
        updated_at: "2026-08-24T10:00:00Z",
        html_url: "https://github.com/acme/insurance-app-base/issues/102",
      },
      repository: REPO,
      installation: INSTALLATION,
      sender: { login: "jerry" },
    }, "fwd-opened");
    await ledgerInsert(db, opened);
    await processWebhook(db, cfg, auth, opened);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards issues to /events when the org uses Software Factory", async () => {
    const { db } = await testDb();
    const cfg = loadConfig({
      CONSOLE_MASTER_KEY: "",
      ORCHESTRATOR_URL: "http://127.0.0.1:8080",
      ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
    } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: true, delivery_guid: "fwd-ft" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const install = job("installation", {
      action: "created",
      installation: { id: INSTALLATION.id, account: { login: "acme" } },
      repositories: [{ node_id: REPO.node_id, full_name: REPO.full_name }],
    }, "fwd-install-2");
    await ledgerInsert(db, install);
    await processWebhook(db, cfg, auth, install);

    const org = (await db.select().from(orgs).limit(1))[0]!;
    await db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, org.id));

    const expiresAt = Date.now() + 60 * 60 * 1000;
    vi.spyOn(auth, "mintInstallationToken").mockResolvedValue({ token: "ghs_from_console", expiresAt });

    const opened = job("issues", {
      action: "labeled",
      issue: {
        id: 102,
        node_id: "I_102b",
        number: 102,
        title: "Add a FACTORY_CANARY.md",
        state: "open",
        body: "canary",
        user: { login: "jerry" },
        labels: [{ name: "factory:fast-track" }],
        created_at: "2026-08-24T10:00:00Z",
        updated_at: "2026-08-24T10:00:00Z",
        html_url: "https://github.com/acme/insurance-app-base/issues/102",
      },
      label: { name: "factory:fast-track" },
      repository: REPO,
      installation: INSTALLATION,
      sender: { login: "jerry" },
    }, "fwd-ft");
    await ledgerInsert(db, opened);
    await processWebhook(db, cfg, auth, opened);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/events");
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: "issues",
      delivery_guid: "fwd-ft",
      payload: { action: "labeled" },
      github_token: "ghs_from_console",
      // The orchestrator queues this delivery and may not use the token for
      // the better part of an hour, so it is told when the token actually dies
      // rather than left to assume.
      github_token_expires_at: new Date(expiresAt).toISOString(),
      console_url: "http://localhost:5173",
    });
    expect(auth.mintInstallationToken).toHaveBeenCalledWith(INSTALLATION.id, expect.objectContaining({ minRemainingMs: 50 * 60 * 1000 }));
  });

  it("skips a retained secret sealed under a different master key and still forwards", async () => {
    const { db } = await testDb();
    const masterKey = randomBytes(32).toString("base64");
    const staleKey = randomBytes(32).toString("base64");
    const cfg = loadConfig({
      CONSOLE_MASTER_KEY: masterKey,
      ORCHESTRATOR_URL: "http://127.0.0.1:8080",
      ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
    } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const install = job("installation", {
      action: "created",
      installation: { id: INSTALLATION.id, account: { login: "acme" } },
      repositories: [{ node_id: REPO.node_id, full_name: REPO.full_name }],
    }, "fwd-install-4");
    await ledgerInsert(db, install);
    await processWebhook(db, cfg, auth, install);
    const org = (await db.select().from(orgs).limit(1))[0]!;
    await db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, org.id));
    await db.insert(orchestratorSecrets).values([
      // Sealed under a key the Console no longer holds — the row every issues
      // delivery used to die on ("Unsupported state or unable to authenticate data").
      { orgId: org.id, name: "ANTHROPIC_API_KEY", encryptedValue: encryptSecret("sk-ant-old", staleKey), updatedBy: "alice" },
      // Sealed under the current key — must still ride along.
      { orgId: org.id, name: "CLAUDE_CODE_OAUTH_TOKEN", encryptedValue: encryptSecret("oat-current", masterKey), updatedBy: "alice" },
    ]);
    vi.spyOn(auth, "mintInstallationToken").mockResolvedValue({ token: "ghs_x", expiresAt: Date.now() + 3_600_000 });

    const opened = job("issues", {
      action: "opened",
      issue: {
        id: 103,
        node_id: "I_103",
        number: 103,
        title: "A brand new issue",
        state: "open",
        body: "",
        user: { login: "jerry" },
        labels: [],
        created_at: "2026-09-01T09:29:57Z",
        updated_at: "2026-09-01T09:29:57Z",
        html_url: "https://github.com/acme/insurance-app-base/issues/103",
      },
      repository: REPO,
      installation: INSTALLATION,
      sender: { login: "jerry" },
    }, "fwd-stale-key");
    await ledgerInsert(db, opened);
    await processWebhook(db, cfg, auth, opened);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("anthropic_api_key");
    expect(body["claude_code_oauth_token"]).toBe("oat-current");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));

    const row = (
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryGuid, "fwd-stale-key"))
    )[0]!;
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toBeNull();
  });

  it("throws on orchestrator network failure so ingest retries", async () => {
    const { db } = await testDb();
    const cfg = loadConfig({
      CONSOLE_MASTER_KEY: "",
      ORCHESTRATOR_URL: "http://127.0.0.1:8080",
      ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
    } as never);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const install = job("installation", {
      action: "created",
      installation: { id: INSTALLATION.id, account: { login: "acme" } },
      repositories: [{ node_id: REPO.node_id, full_name: REPO.full_name }],
    }, "fwd-install-3");
    await ledgerInsert(db, install);
    await processWebhook(db, cfg, auth, install);
    const org = (await db.select().from(orgs).limit(1))[0]!;
    await db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, org.id));

    const opened = job("issues", {
      action: "opened",
      issue: {
        id: 97,
        node_id: "I_97",
        number: 97,
        title: "Change the title",
        state: "open",
        body: "",
        user: { login: "jerry" },
        labels: [{ name: "factory:fast-track" }],
        created_at: "2026-08-24T10:00:00Z",
        updated_at: "2026-08-24T10:00:00Z",
        html_url: "https://github.com/acme/insurance-app-base/issues/97",
      },
      repository: REPO,
      installation: INSTALLATION,
      sender: { login: "jerry" },
    }, "fwd-fail");
    await ledgerInsert(db, opened);
    await expect(processWebhook(db, cfg, auth, opened)).rejects.toThrow(/could not reach the orchestrator/);
  });
});
