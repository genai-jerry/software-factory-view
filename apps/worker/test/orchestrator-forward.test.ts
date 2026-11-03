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

  it("forwards a merged pull request, and only a merged one", async () => {
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
    }, "fwd-install-3");
    await ledgerInsert(db, install);
    await processWebhook(db, cfg, auth, install);
    const org = (await db.select().from(orgs).limit(1))[0]!;
    await db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, org.id));

    const pull = (over: Record<string, unknown>) => ({
      id: 601,
      node_id: "PR_promo",
      number: 110,
      title: "release(34): promote staging to main",
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: "staging", sha: "aaa111" },
      base: { ref: "main" },
      user: { login: "github-actions[bot]" },
      updated_at: "2026-11-03T03:00:00Z",
      html_url: "https://github.com/acme/insurance-app-base/pull/110",
      ...over,
    });
    const opened = job("pull_request", { action: "opened", pull_request: pull({}), repository: REPO, installation: INSTALLATION }, "fwd-pr-open");
    await ledgerInsert(db, opened);
    await processWebhook(db, cfg, auth, opened);
    const closedUnmerged = job("pull_request", { action: "closed", pull_request: pull({ state: "closed" }), repository: REPO, installation: INSTALLATION }, "fwd-pr-closed");
    await ledgerInsert(db, closedUnmerged);
    await processWebhook(db, cfg, auth, closedUnmerged);
    expect(fetchMock).not.toHaveBeenCalled();

    const merged = job(
      "pull_request",
      { action: "closed", pull_request: pull({ state: "closed", merged: true, merged_at: "2026-11-03T03:37:54Z", merge_commit_sha: "d88ad92" }), repository: REPO, installation: INSTALLATION },
      "fwd-pr-merged",
    );
    await ledgerInsert(db, merged);
    await processWebhook(db, cfg, auth, merged);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ event: "pull_request", delivery_guid: "fwd-pr-merged", payload: { action: "closed" } });
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
