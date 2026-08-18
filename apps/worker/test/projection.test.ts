import { loadConfig, AppAuth } from "@console/core";
import { comments, issues, issueStateHistory, pullRequests, runs, threadEntries, threads, webhookDeliveries } from "@console/db";
import { describe, expect, it } from "vitest";
import { processWebhook, type WebhookJob } from "../src/ingest.js";
import { fixtureDeliveries } from "./fixtures.js";
import { testDb } from "./helpers.js";

const cfg = loadConfig({ CONSOLE_MASTER_KEY: "" } as never); // empty key: artifact prefetch (network) disabled
const auth = new AppAuth({ apiUrl: "https://api.invalid", appId: "", privateKeyPem: "", oauthClientId: "", oauthClientSecret: "" });

async function ledgerInsert(db: Awaited<ReturnType<typeof testDb>>["db"], job: WebhookJob): Promise<void> {
  await db.insert(webhookDeliveries).values({ deliveryGuid: job.deliveryGuid, event: job.event }).onConflictDoNothing();
}

async function snapshot(db: Awaited<ReturnType<typeof testDb>>["db"]) {
  const issueRows = (await db.select().from(issues)).map((i) => ({
    number: i.number,
    title: i.title,
    kind: i.kind,
    state: i.factoryState,
    hasParent: i.parentIssueId !== null,
  }));
  const commentRows = (await db.select().from(comments)).map((c) => ({
    node: c.ghNodeId,
    isAgent: c.isAgent,
    isApproval: c.isApproval,
    thread: c.consoleMarkers.thread ?? null,
  }));
  const prRows = (await db.select().from(pullRequests)).map((p) => ({ number: p.number, kind: p.kind, issue: p.issueNumber }));
  const historyCount = (await db.select().from(issueStateHistory)).length;
  const threadRows = (await db.select().from(threads)).map((t) => t.topicRef).sort();
  const entryRows = (await db.select().from(threadEntries)).length;
  const runRows = (await db.select().from(runs)).map((r) => ({ id: r.ghRunId, role: r.role, conclusion: r.conclusion }));
  return {
    issues: issueRows.sort((a, b) => a.number - b.number),
    comments: commentRows.sort((a, b) => a.node.localeCompare(b.node)),
    prs: prRows,
    historyCount,
    threads: threadRows,
    entryCount: entryRows,
    runs: runRows,
  };
}

describe("projection pipeline", () => {
  it("projects a full epic flow: kinds, states, threads, classification", async () => {
    const { db } = await testDb();
    for (const job of fixtureDeliveries()) {
      await ledgerInsert(db, job);
      await processWebhook(db, cfg, auth, job);
    }
    const s = await snapshot(db);

    expect(s.issues).toEqual([
      { number: 16, title: "Payment reminders", kind: "epic", state: "factory:spec-approved", hasParent: false },
      { number: 21, title: "task(backend): reminder scheduler", kind: "task", state: "factory:ready", hasParent: true },
    ]);
    // Classification: agent comment, exact Approved, console-threaded reply.
    expect(s.comments).toEqual([
      { node: "IC_c1", isAgent: true, isApproval: false, thread: null },
      { node: "IC_c2", isAgent: false, isApproval: true, thread: null },
      { node: "IC_c3", isAgent: false, isApproval: false, thread: "artifact/proposal" },
    ]);
    expect(s.prs).toEqual([{ number: 17, kind: "spec", issue: 16 }]);
    // Epic default threads + task thread exist; three comments filed into threads.
    expect(s.threads).toContain("gate/spec");
    expect(s.threads).toContain("artifact/proposal");
    expect(s.threads).toContain("inbox");
    expect(s.entryCount).toBe(3);
    expect(s.runs).toEqual([{ id: 42001, role: null, conclusion: "success" }]);
    // Label events recorded: intake +, intake -, spec-ready +, spec-approved +, task ready + = 5
    expect(s.historyCount).toBe(5);
  });

  it("keeps an open epic's kind sticky when every factory:* label is removed", async () => {
    const { db } = await testDb();
    const repo = { node_id: "R_repo2", full_name: "acme/app2", default_branch: "main", private: true };
    const base = {
      id: 23,
      node_id: "I_ft23",
      number: 23,
      title: "Factory profile action not running",
      state: "open",
      body: "The profile run stops at the first step.",
      user: { login: "jerry" },
      created_at: "2026-08-18T09:00:00Z",
      closed_at: null,
      html_url: "https://github.com/acme/app2/issues/23",
    };
    const jobs: WebhookJob[] = [
      {
        deliveryGuid: "sk-1",
        event: "installation",
        payload: { action: "created", installation: { id: 888, account: { login: "acme" } }, repositories: [repo] },
      },
      {
        deliveryGuid: "sk-2",
        event: "issues",
        payload: {
          action: "opened",
          issue: { ...base, labels: [{ name: "factory:fast-track" }], updated_at: "2026-08-18T09:00:00Z" },
          repository: repo,
          installation: { id: 888 },
          sender: { login: "jerry" },
        },
      },
      // The fast lane bails out: label removed, nothing applied in its place.
      {
        deliveryGuid: "sk-3",
        event: "issues",
        payload: {
          action: "unlabeled",
          issue: { ...base, labels: [], updated_at: "2026-08-18T09:10:00Z" },
          label: { name: "factory:fast-track" },
          repository: repo,
          installation: { id: 888 },
          sender: { login: "claude[bot]" },
        },
      },
    ];
    for (const job of jobs) {
      await ledgerInsert(db, job);
      await processWebhook(db, cfg, auth, job);
    }
    const rows = (await db.select().from(issues)).map((i) => ({ number: i.number, kind: i.kind, state: i.factoryState }));
    // Without sticky kind this re-derived to "plain" and vanished from the
    // board and tree; it must stay an epic (state null → the Held column).
    expect(rows).toEqual([{ number: 23, kind: "epic", state: null }]);
  });

  it("is idempotent and order-tolerant: shuffled + duplicated replay converges to the same state", async () => {
    const forward = await testDb();
    for (const job of fixtureDeliveries()) {
      await ledgerInsert(forward.db, job);
      await processWebhook(forward.db, cfg, auth, job);
    }
    const expected = await snapshot(forward.db);

    // Reversed within constraints (installation first so repo rows exist — in
    // production ensureRepo creates them on demand from any event), plus every
    // delivery processed twice.
    const jobs = fixtureDeliveries();
    const [install, ...rest] = jobs;
    const shuffled = [install!, ...rest.reverse(), ...jobs];
    const replay = await testDb();
    for (const job of shuffled) {
      await ledgerInsert(replay.db, job);
      await processWebhook(replay.db, cfg, auth, job);
    }
    const got = await snapshot(replay.db);

    expect(got.issues).toEqual(expected.issues);
    expect(got.comments).toEqual(expected.comments);
    expect(got.prs).toEqual(expected.prs);
    expect(got.threads).toEqual(expected.threads);
    expect(got.entryCount).toEqual(expected.entryCount);
    expect(got.runs).toEqual(expected.runs);
    // History dedupes on (issue, sourceEventId): duplicates add nothing.
    expect(got.historyCount).toBe(expected.historyCount);
  });
});
