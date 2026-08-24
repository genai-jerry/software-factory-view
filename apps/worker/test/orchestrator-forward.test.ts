import { loadConfig, AppAuth } from "@console/core";
import { orgs, webhookDeliveries } from "@console/db";
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
    });
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
