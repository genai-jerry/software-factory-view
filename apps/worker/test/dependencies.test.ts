import type { GhIssue, RepoReader } from "@console/core";
import { estates, issues, orgs, repos, taskDependencies } from "@console/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { repairDependencies } from "../src/artifacts.js";
import { projectIssue, type RepoRef } from "../src/project.js";
import { testDb } from "./helpers.js";

/** Assignee projection and dependency edges (plan 08 WP2/WP3). */

function ghIssue(over: Partial<GhIssue> & { number: number }): GhIssue {
  return {
    id: over.number,
    node_id: `I_${over.number}`,
    title: `task(x): thing ${over.number}`,
    state: "open",
    body: null,
    user: { login: "alice" },
    assignees: [],
    labels: [{ name: "factory:ready" }],
    updated_at: "2026-08-01T10:00:00Z",
    created_at: "2026-08-01T09:00:00Z",
    closed_at: null,
    html_url: `https://github.invalid/${over.number}`,
    ...over,
  };
}

async function seedRepo(db: Awaited<ReturnType<typeof testDb>>["db"]): Promise<RepoRef> {
  const org = (await db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  const estate = (await db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (
    await db.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_1", fullName: "acme/app" }).returning()
  )[0]!;
  return { id: repo.id, orgId: org.id, estateId: estate.id, fullName: "acme/app", defaultBranch: "main" };
}

describe("assignee projection", () => {
  it("projects assignees, replaces them on update, and ignores stale deliveries", async () => {
    const { db } = await testDb();
    const repo = await seedRepo(db);

    await projectIssue(db, repo, ghIssue({ number: 1, assignees: [{ login: "jerry" }] }));
    let row = (await db.select().from(issues).where(eq(issues.number, 1)))[0]!;
    expect(row.assignees).toEqual(["jerry"]);

    await projectIssue(db, repo, ghIssue({ number: 1, assignees: [{ login: "sam" }], updated_at: "2026-08-02T10:00:00Z" }));
    row = (await db.select().from(issues).where(eq(issues.number, 1)))[0]!;
    expect(row.assignees).toEqual(["sam"]);

    // A stale delivery (older gh_updated_at) must not clobber.
    await projectIssue(db, repo, ghIssue({ number: 1, assignees: [{ login: "old" }], updated_at: "2026-08-01T00:00:00Z" }));
    row = (await db.select().from(issues).where(eq(issues.number, 1)))[0]!;
    expect(row.assignees).toEqual(["sam"]);
  });
});

describe("body-sourced dependencies", () => {
  it("creates edges from markers, drops them when the marker goes, resists stale bodies", async () => {
    const { db } = await testDb();
    const repo = await seedRepo(db);
    await projectIssue(db, repo, ghIssue({ number: 1 }));
    await projectIssue(db, repo, ghIssue({ number: 2, body: "Blocked by #1" }));

    let deps = await db.select().from(taskDependencies);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.source).toBe("body");

    // Stale body without the marker: edge survives.
    await projectIssue(db, repo, ghIssue({ number: 2, body: "nothing", updated_at: "2026-07-01T10:00:00Z" }));
    expect(await db.select().from(taskDependencies)).toHaveLength(1);

    // Fresh body without the marker: edge goes.
    await projectIssue(db, repo, ghIssue({ number: 2, body: "nothing", updated_at: "2026-08-03T10:00:00Z" }));
    expect(await db.select().from(taskDependencies)).toHaveLength(0);
  });

  it("skips self-references and unknown numbers", async () => {
    const { db } = await testDb();
    const repo = await seedRepo(db);
    await projectIssue(db, repo, ghIssue({ number: 3, body: "blocked by #3\ndepends on #99" }));
    expect(await db.select().from(taskDependencies)).toHaveLength(0);
  });
});

describe("repairDependencies (native relations)", () => {
  it("mirrors blocked_by, wins over body rows, and removes dropped relations", async () => {
    const { db } = await testDb();
    const repo = await seedRepo(db);
    await projectIssue(db, repo, ghIssue({ number: 1 }));
    await projectIssue(db, repo, ghIssue({ number: 2, body: "Blocked by #1" }));

    const reader = {
      listBlockedBy: async (_o: string, _r: string, num: number) => (num === 2 ? [ghIssue({ number: 1 })] : []),
    } as unknown as RepoReader;
    await repairDependencies(db, repo, reader);

    let deps = await db.select().from(taskDependencies);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.source).toBe("github"); // github replaced the body row for the same pair

    // Relation removed upstream → repair deletes the github row.
    const emptyReader = { listBlockedBy: async () => [] } as unknown as RepoReader;
    await repairDependencies(db, repo, emptyReader);
    deps = await db.select().from(taskDependencies);
    expect(deps).toHaveLength(0);
  });
});
