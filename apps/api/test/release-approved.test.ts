import { randomBytes } from "node:crypto";
import { CredentialStore, buildWork, encryptSecret, loadConfig } from "@console/core";
import { comments, estates, issueStateHistory, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { readNeed } from "../src/release-meta.js";

/**
 * Gate GS once it is approved (beacon-api#324): the label stays at
 * factory:epic-ready while the Release Manager finishes, so Compass must not
 * ask for the release again. It shows who approved, and the factory's own
 * "You need to" becomes the decision — in the queue, on the item, on Telegram.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=s1";
const headers = { cookie, "x-console-csrf": "1", "content-type": "application/json" };
const id: Record<string, string> = {};
let n = 1;

const RM_ASK = [
  "**The test data merge is built and green. It needs review before this epic can go to staging.**",
  "",
  "**You need to:** Merge [the design document for Beacon's web app](https://github.com/acme/web/pull/70) — that is design approval (G2) for that repo.",
  "",
  "<!-- factory-agent -->",
].join("\n");

async function comment(body: string, at: Date, opts: { agent?: boolean; author?: string } = {}) {
  const k = n++;
  await deps.dbh.db.insert(comments).values({
    orgId: id.org!,
    issueId: id.epic!,
    ghNodeId: `C${k}`,
    ghId: k,
    author: opts.author ?? (opts.agent ? "factory[bot]" : "alice"),
    body,
    isAgent: Boolean(opts.agent),
    ghCreatedAt: at,
    ghUpdatedAt: at,
  });
}

beforeAll(async () => {
  const pg = new PGlite();
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(dir, f), "utf8")).split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg) as never;
  deps = {
    cfg: loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test" } as never),
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://gh.test",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);
  const d = deps.dbh.db;
  const u = (await d.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  id.org = org.id;
  await d.insert(memberships).values({ orgId: org.id, userId: u.id, role: "owner" });
  await d.insert(sessions).values({ id: "s1", userId: u.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/api", factoryEnabled: true }).returning())[0]!;
  const epic = (
    await d
      .insert(issues)
      .values({
        orgId: org.id,
        repoId: repo.id,
        ghNodeId: "I324",
        number: 324,
        title: "Outbox shows the whole conversation",
        kind: "epic",
        state: "open",
        factoryState: "factory:epic-ready",
        labels: ["factory:epic-ready", "factory:expedite"],
        ghCreatedAt: new Date("2026-11-09T09:00:00Z"),
        ghUpdatedAt: new Date(),
        htmlUrl: "https://github.com/acme/api/issues/324",
      })
      .returning()
  )[0]!;
  id.epic = epic.id;
  await d.insert(issueStateHistory).values({
    orgId: org.id,
    issueId: epic.id,
    fromState: "factory:design-approved",
    toState: "factory:epic-ready",
    occurredAt: new Date("2026-11-09T13:30:00Z"),
    sourceEventId: "e1",
  });
});

beforeEach(async () => {
  await deps.dbh.db.delete(comments);
});

const needsYou = async () => (await app.inject({ method: "GET", url: "/api/my-work", headers: { cookie } })).json().needsYou as Array<{ kind: string; question: string | null; requestLink?: string | null; approvedBy?: string | null }>;

describe("gate GS before it is approved", () => {
  it("asks for the release", async () => {
    const got = await needsYou();
    expect(got.map((e) => e.kind)).toEqual(["gate"]);
    const gate = (await app.inject({ method: "GET", url: `/api/epics/${id.epic}/gate`, headers: { cookie } })).json();
    expect(gate.releaseApproved).toBeNull();
  });

  it("does not count an Approved from before the epic reached the gate (that was the design's)", async () => {
    await comment("Approved", new Date("2026-11-09T10:00:00Z"));
    expect((await needsYou()).map((e) => e.kind)).toEqual(["gate"]);
  });
});

describe("gate GS once approved", () => {
  it("never asks again; the factory's 'You need to' becomes the decision", async () => {
    await comment("Approved", new Date("2026-11-09T13:43:00Z"));
    await comment(RM_ASK, new Date("2026-11-09T15:15:00Z"), { agent: true });

    const got = await needsYou();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "request",
      question: "Merge the design document for Beacon's web app — that is design approval (G2) for that repo.",
      requestLink: "https://github.com/acme/web/pull/70",
      approvedBy: "alice",
    });

    const gate = (await app.inject({ method: "GET", url: `/api/epics/${id.epic}/gate`, headers: { cookie } })).json();
    expect(gate.releaseApproved).toMatchObject({ by: "alice", askLink: "https://github.com/acme/web/pull/70" });

    const again = await app.inject({ method: "POST", url: `/api/epics/${id.epic}/gate/approve`, headers, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already approved by @alice; that approval stands/);
  });

  it("asks nothing while the factory finishes, and the board says so", async () => {
    await comment("Approved", new Date("2026-11-09T13:43:00Z"));
    await comment("**Release** is running…\n\n<!-- factory-agent -->", new Date("2026-11-09T13:44:00Z"), { agent: true });
    expect(await needsYou()).toEqual([]);

    const board = (await app.inject({ method: "GET", url: "/api/board", headers: { cookie } })).json();
    const card = board.cards.find((c: { number: number }) => c.number === 324);
    expect(card.releaseApprovedBy).toBe("alice");
    const work = buildWork([card], [], []);
    expect(work.working[0]!.pointer).toBe("Release approved by @alice. The factory is finishing the last pieces.");
  });
});

describe("reading the factory's line", () => {
  it("drops markdown and keeps the first link", () => {
    expect(readNeed(RM_ASK)).toEqual({
      text: "Merge the design document for Beacon's web app — that is design approval (G2) for that repo.",
      link: "https://github.com/acme/web/pull/70",
    });
    expect(readNeed("Nothing to do.")).toBeNull();
  });
});

describe("on Telegram", () => {
  it("sends the factory's request with a link to it, and no approve button", async () => {
    const { renderDecision } = await import("../src/telegram/render.js");
    await comment("Approved", new Date("2026-11-09T13:43:00Z"));
    await comment(RM_ASK, new Date("2026-11-09T15:15:00Z"), { agent: true });
    const board = (await app.inject({ method: "GET", url: "/api/board", headers: { cookie } })).json();
    const work = buildWork(board.cards, (await needsYou()) as never, []);
    const item = work.needsDecision[0]!;
    expect(item.ask).toBe("act");
    const { html, keyboard } = renderDecision(item, "n1", "https://compass.example.com");
    expect(html).toContain("The factory needs you before it can release");
    expect(html).toContain("Merge the design document");
    const buttons = keyboard.flat();
    expect(buttons.find((b) => b.text === "Open it on GitHub")).toMatchObject({ url: "https://github.com/acme/web/pull/70" });
    expect(buttons.some((b) => /approve|release/i.test(b.text))).toBe(false);
  });
});
