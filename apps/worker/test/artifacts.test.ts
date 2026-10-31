import { artifactCache, changeArtifacts, estates, issues, orgs, repos } from "@console/db";
import type { RepoReader } from "@console/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { refreshEpicArtifacts } from "../src/artifacts.js";
import { testDb } from "./helpers.js";

/**
 * Where an epic's documents are read from once their PRs have merged.
 *
 * With epic branches on (FACTORY.md §6b) the spec, design and test plan merge
 * onto `factory/epic-<n>` and reach the default branch only when the epic
 * ships. Beacon #35 on 31 Oct 2026 had every document on its epic branch,
 * none on `main`, no document PR open — and the Console had cached no
 * version of any of them, so the Test board could show no steps.
 */

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAN = "openspec/changes/35-daywise/system-tests/test-plan.md";

function reader(filesByRef: Record<string, Record<string, string>>): RepoReader {
  return {
    listPullFiles: async () => {
      throw new Error("no pull requests");
    },
    listDir: async (_o: string, _r: string, path: string) => {
      const all = new Set(Object.values(filesByRef).flatMap((f) => Object.keys(f)));
      const out = new Map<string, { path: string; type: string }>();
      for (const p of all) {
        if (!p.startsWith(`${path}/`)) continue;
        const rest = p.slice(path.length + 1);
        const head = rest.split("/")[0]!;
        const child = `${path}/${head}`;
        out.set(child, { path: child, type: rest.includes("/") ? "dir" : "file" });
      }
      return [...out.values()];
    },
    getFileAtRef: async (_o: string, _r: string, path: string, ref?: string) => {
      const content = filesByRef[ref ?? "main"]?.[path];
      return content === undefined ? null : { content, sha: `${ref}-${path}` };
    },
  } as unknown as RepoReader;
}

async function seed() {
  const { db } = await testDb();
  const org = (await db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  const estate = (await db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (
    await db
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_1", fullName: "acme/api", defaultBranch: "main" })
      .returning()
  )[0]!;
  const epic = (
    await db
      .insert(issues)
      .values({ orgId: org.id, repoId: repo.id, ghNodeId: "I_35", number: 35, title: "Day-wise", state: "open", ghUpdatedAt: new Date() })
      .returning()
  )[0]!;
  return {
    db,
    epic,
    repoRef: { id: repo.id, orgId: org.id, estateId: estate.id, fullName: "acme/api", defaultBranch: "main", stagingBranch: null },
  };
}

describe("refreshEpicArtifacts", () => {
  it("caches a document that lives only on the epic branch as its approved version", async () => {
    const { db, epic, repoRef } = await seed();
    await refreshEpicArtifacts(db, repoRef, reader({ "factory/epic-35": { [PLAN]: "# Plan\n" } }), epic.id, 35, MASTER_KEY);
    const rows = await db.select().from(changeArtifacts).where(eq(changeArtifacts.path, PLAN));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mergedSha).toBe(`factory/epic-35-${PLAN}`);
    expect(rows[0]!.latestSha).toBe(`factory/epic-35-${PLAN}`);
    expect(await db.select().from(artifactCache).where(eq(artifactCache.path, PLAN))).toHaveLength(1);
  });

  it("prefers the default branch when the document is there too", async () => {
    const { db, epic, repoRef } = await seed();
    await refreshEpicArtifacts(
      db,
      repoRef,
      reader({ main: { [PLAN]: "# Shipped plan\n" }, "factory/epic-35": { [PLAN]: "# Plan\n" } }),
      epic.id,
      35,
      MASTER_KEY,
    );
    const row = (await db.select().from(changeArtifacts).where(eq(changeArtifacts.path, PLAN)))[0]!;
    expect(row.mergedSha).toBe(`main-${PLAN}`);
  });
});
