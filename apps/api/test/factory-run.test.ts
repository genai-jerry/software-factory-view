import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

const MASTER_KEY = randomBytes(32).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const cookie = "console_session=sess-1";

let app: Awaited<ReturnType<typeof buildApp>>;
let epicId: string;
let deps_: AppDeps;

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg);
  const cfg = loadConfig({
    CONSOLE_MASTER_KEY: MASTER_KEY,
    NODE_ENV: "test",
    ORCHESTRATOR_URL: "http://127.0.0.1:8080",
    ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
  } as never);
  const deps: AppDeps = {
    cfg,
    dbh: { db: db as never, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: PKCS8, webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (
    await deps.dbh.db.insert(orgs).values({ name: "acme", orchestrator: "software-factory" }).returning()
  )[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning())[0]!;
  const repo = (
    await deps.dbh.db
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/insurance-app-base" })
      .returning()
  )[0]!;
  const epic = (
    await deps.dbh.db
      .insert(issues)
      .values({
        orgId: org.id,
        repoId: repo.id,
        ghNodeId: "I102",
        number: 102,
        title: "Add a FACTORY_CANARY.md with the run date",
        state: "open",
        kind: "epic",
        factoryState: "factory:fast-track",
        labels: ["factory:fast-track"],
        ghUpdatedAt: new Date(),
        htmlUrl: "https://github.com/acme/insurance-app-base/issues/102",
      })
      .returning()
  )[0]!;
  epicId = epic.id;
  deps_ = deps;
  app = await buildApp(deps);
});

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/epics/:id/factory-run", () => {
  it("requires a session", async () => {
    const res = await app.inject({ method: "POST", url: `/api/epics/${epicId}/factory-run` });
    expect(res.statusCode).toBe(401);
  });

  it("synthesizes a labeled fast-track event for the orchestrator", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_from_console",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201 },
        );
      }
      if (href.includes("/issues/102")) {
        return new Response(
          JSON.stringify({
            number: 102,
            title: "Add a FACTORY_CANARY.md",
            state: "open",
            labels: [{ name: "factory:fast-track" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ queued: true, delivery_guid: "console-kick-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/factory-run`,
      headers: { cookie, "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true, action: "labeled", label: "factory:fast-track" });

    const eventCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/events"));
    expect(eventCall).toBeTruthy();
    const [url, init] = eventCall as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/events");
    const body = JSON.parse(init.body as string) as {
      event: string;
      delivery_guid: string;
      github_token?: string;
      console_url?: string;
      payload: {
        action: string;
        label?: { name: string };
        issue: { number: number };
        installation?: { id: number };
      };
    };
    expect(body.event).toBe("issues");
    expect(body.delivery_guid).toMatch(/^console-kick-/);
    expect(body.github_token).toBe("ghs_from_console");
    expect(body.console_url).toBe("http://localhost:5173");
    expect(body.payload).toMatchObject({
      action: "labeled",
      label: { name: "factory:fast-track" },
      issue: { number: 102 },
      installation: { id: 99 },
    });
  });

  it("refuses to start while a factory:in-progress marker is still on the issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes("/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
            status: 201,
          });
        }
        if (href.includes("/issues/102")) {
          return new Response(
            JSON.stringify({
              number: 102,
              state: "open",
              labels: [{ name: "factory:fast-track" }, { name: "factory:in-progress" }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ queued: true }), { status: 200 });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/factory-run`,
      headers: { cookie, "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/factory:in-progress/);
  });

  it("exposes canStart and a handoff diagnosis on the epic workspace", async () => {
    // The orchestrator is not up in this test; the workspace must still answer.
    const res = await app.inject({ method: "GET", url: `/api/epics/${epicId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: true },
    });
    expect(body.orchestrator.handoff.startsRole).toMatchObject({ role: "fasttrack", human: "fast lane" });
    expect(body.orchestrator.handoff.status).toBe("waiting");
    expect(body.orchestrator.handoff.runsError).toBeTruthy();
  });
});

describe("POST /api/epics/:id/factory-run/clear-marker", () => {
  it("removes the marker on GitHub and in the projection", async () => {
    await deps_.dbh.db
      .update(issues)
      .set({ labels: ["factory:fast-track", "factory:in-progress"], factoryState: "factory:in-progress" })
      .where(eq(issues.id, epicId));

    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        calls.push({ method: init?.method ?? "GET", url: href });
        if (href.includes("/runs")) return new Response(JSON.stringify([]), { status: 200 });
        // DELETE .../labels/{name} answers with the remaining labels.
        return new Response(JSON.stringify([{ name: "factory:fast-track" }]), { status: 200 });
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/factory-run/clear-marker`,
      headers: { cookie, "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cleared: true, labels: ["factory:fast-track"] });
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("labels/factory%3Ain-progress"))).toBe(true);

    const row = (await deps_.dbh.db.select().from(issues).where(eq(issues.id, epicId)).limit(1))[0]!;
    expect(row.labels).toEqual(["factory:fast-track"]);
    expect(row.factoryState).toBe("factory:fast-track");
  });

  it("refuses while the orchestrator still reports a live run inside the role timeout", async () => {
    await deps_.dbh.db
      .update(issues)
      .set({ labels: ["factory:fast-track", "factory:in-progress"] })
      .where(eq(issues.id, epicId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/runs")) {
          return new Response(
            JSON.stringify([{ id: "r1", role: "fasttrack", started_at: new Date().toISOString(), finished_at: null }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/factory-run/clear-marker`,
      headers: { cookie, "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/live fasttrack run/);
  });
});
