import { randomBytes } from "node:crypto";
import { UserClient } from "@console/core";
import { estates, memberships, orgs, repos, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapMemberships } from "../src/auth.js";
import type { AppDeps } from "../src/context.js";

/**
 * The sign-in membership bootstrap is the wall between accounts: joining an
 * org is what makes its repositories visible, so read access to a public repo
 * must never be enough — otherwise every signed-in user sees every org.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

let deps: AppDeps;
let github: Record<string, { status?: number; body: unknown }>;
let networkDown: boolean;

const gh = () => new UserClient("https://api.invalid", "gho_test");

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg);
  deps = { dbh: { db: db as never, sql: null as never, close: async () => undefined } } as AppDeps;

  networkDown = false;
  github = {
    "/user/installations": { body: { installations: [] } },
  };
  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string }) => {
    if (networkDown) throw new Error("network unreachable");
    const pathname = String(url).replace(/^https:\/\/[^/]+/, "").split("?")[0]!;
    const hit = github[pathname];
    if (!hit) throw new Error(`unstubbed GitHub call: ${init?.method ?? "GET"} ${pathname}`);
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function seedEstate(name: string, installationId: number, repoFullName: string) {
  const { db } = deps.dbh;
  const org = (await db.insert(orgs).values({ name }).returning())[0]!;
  const estate = (await db.insert(estates).values({ orgId: org.id, name, installationId }).returning())[0]!;
  await db.insert(repos).values({
    orgId: org.id,
    estateId: estate.id,
    ghNodeId: `R_${installationId}`,
    fullName: repoFullName,
  });
  return { org, estate };
}

async function seedUser(login: string, ghUserId: number) {
  return (await deps.dbh.db.insert(users).values({ ghUserId, login }).returning())[0]!;
}

const rolesFor = async (userId: string) =>
  (await deps.dbh.db.select().from(memberships)).filter((m) => m.userId === userId).map((m) => m.role);

describe("bootstrapMemberships", () => {
  it("does not seat a stranger who can merely read a public repo", async () => {
    await seedEstate("jerrykurian", 99, "jerrykurian/happytrip");
    const stranger = await seedUser("genai-jerry", 7);
    github["/repos/jerrykurian/happytrip"] = {
      body: { node_id: "R_99", full_name: "jerrykurian/happytrip", default_branch: "main", private: false, permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } },
    };

    await bootstrapMemberships(deps, stranger.id, gh());
    expect(await rolesFor(stranger.id)).toEqual([]);
  });

  it("seats a collaborator with push access — first member becomes owner", async () => {
    await seedEstate("acme", 99, "acme/api");
    const dev = await seedUser("alice", 42);
    github["/repos/acme/api"] = {
      body: { node_id: "R_99", full_name: "acme/api", default_branch: "main", private: false, permissions: { admin: false, push: true, pull: true } },
    };

    await bootstrapMemberships(deps, dev.id, gh());
    expect(await rolesFor(dev.id)).toEqual(["owner"]);
  });

  it("seats a user who can see the estate's installation, even with read-only repo access", async () => {
    const { org } = await seedEstate("acme", 99, "acme/api");
    const owner = await seedUser("carol", 1);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: owner.id, role: "owner" });
    const member = await seedUser("alice", 42);
    github["/user/installations"] = { body: { installations: [{ id: 99, account: { id: 7, login: "acme" } }] } };
    github["/repos/acme/api"] = {
      body: { node_id: "R_99", full_name: "acme/api", default_branch: "main", private: false, permissions: { admin: false, push: false, pull: true } },
    };

    await bootstrapMemberships(deps, member.id, gh());
    expect(await rolesFor(member.id)).toEqual(["member"]);
  });

  it("seats a GitHub repo admin as org admin when the org already has an owner", async () => {
    const { org } = await seedEstate("acme", 99, "acme/api");
    const owner = await seedUser("carol", 1);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: owner.id, role: "owner" });
    const admin = await seedUser("alice", 42);
    github["/repos/acme/api"] = {
      body: { node_id: "R_99", full_name: "acme/api", default_branch: "main", private: false, permissions: { admin: true, push: true, pull: true } },
    };

    await bootstrapMemberships(deps, admin.id, gh());
    expect(await rolesFor(admin.id)).toEqual(["admin"]);
  });

  it("revokes a readability-era member row once GitHub affirms read-only access", async () => {
    const { org } = await seedEstate("jerrykurian", 99, "jerrykurian/happytrip");
    const stranger = await seedUser("genai-jerry", 7);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: stranger.id, role: "member" });
    github["/repos/jerrykurian/happytrip"] = {
      body: { node_id: "R_99", full_name: "jerrykurian/happytrip", default_branch: "main", private: false, permissions: { admin: false, push: false, pull: true } },
    };

    await bootstrapMemberships(deps, stranger.id, gh());
    expect(await rolesFor(stranger.id)).toEqual([]);
  });

  it("revokes a member row when the user cannot see the repo at all (404)", async () => {
    const { org } = await seedEstate("acme", 99, "acme/secret");
    const gone = await seedUser("mallory", 13);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: gone.id, role: "member" });
    github["/repos/acme/secret"] = { status: 404, body: { message: "Not Found" } };

    await bootstrapMemberships(deps, gone.id, gh());
    expect(await rolesFor(gone.id)).toEqual([]);
  });

  it("leaves hand-assigned viewer rows and earned owner rows alone", async () => {
    const { org } = await seedEstate("acme", 99, "acme/api");
    const viewer = await seedUser("vera", 8);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: viewer.id, role: "viewer" });
    const owner = await seedUser("carol", 1);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: owner.id, role: "owner" });
    github["/repos/acme/api"] = {
      body: { node_id: "R_99", full_name: "acme/api", default_branch: "main", private: false, permissions: { admin: false, push: false, pull: true } },
    };

    await bootstrapMemberships(deps, viewer.id, gh());
    await bootstrapMemberships(deps, owner.id, gh());
    expect(await rolesFor(viewer.id)).toEqual(["viewer"]);
    expect(await rolesFor(owner.id)).toEqual(["owner"]);
  });

  it("changes nothing when GitHub is unreachable", async () => {
    const { org } = await seedEstate("acme", 99, "acme/api");
    const member = await seedUser("alice", 42);
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: member.id, role: "member" });
    networkDown = true;

    await bootstrapMemberships(deps, member.id, gh());
    expect(await rolesFor(member.id)).toEqual(["member"]);
  });

  it("keeps orgs isolated across accounts: each user ends up only in their own org", async () => {
    await seedEstate("jerrykurian", 99, "jerrykurian/happytrip");
    await seedEstate("genai-jerry", 500, "genai-jerry/insurance-app-base");
    const jerry = await seedUser("jerrykurian", 1);
    const genai = await seedUser("genai-jerry", 2);
    // Both repos are public: everyone can read both, each administers only their own.
    const repoBody = (nodeId: string, fullName: string, mine: boolean) => ({
      body: { node_id: nodeId, full_name: fullName, default_branch: "main", private: false, permissions: { admin: mine, push: mine, pull: true } },
    });

    github["/repos/jerrykurian/happytrip"] = repoBody("R_99", "jerrykurian/happytrip", true);
    github["/repos/genai-jerry/insurance-app-base"] = repoBody("R_500", "genai-jerry/insurance-app-base", false);
    await bootstrapMemberships(deps, jerry.id, gh());

    github["/repos/jerrykurian/happytrip"] = repoBody("R_99", "jerrykurian/happytrip", false);
    github["/repos/genai-jerry/insurance-app-base"] = repoBody("R_500", "genai-jerry/insurance-app-base", true);
    await bootstrapMemberships(deps, genai.id, gh());

    const all = await deps.dbh.db.select().from(memberships);
    const orgRows = await deps.dbh.db.select().from(orgs);
    const orgName = (id: string) => orgRows.find((o) => o.id === id)?.name;
    expect(all.map((m) => [m.userId === jerry.id ? "jerrykurian" : "genai-jerry", orgName(m.orgId), m.role]).sort()).toEqual([
      ["genai-jerry", "genai-jerry", "owner"],
      ["jerrykurian", "jerrykurian", "owner"],
    ]);
  });
});
