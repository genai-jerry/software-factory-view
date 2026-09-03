import { estates, orgs, repos } from "@console/db";
import type { RepoReader } from "@console/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { importTestingPolicy } from "../src/artifacts.js";
import { testDb } from "./helpers.js";

/**
 * Mirroring `.github/factory-testing.json` onto the repo row (FACTORY.md §4b).
 *
 * The mirror answers one question for the Console: may this repo be offered
 * anything about system tests? Three answers, and they must stay three — on,
 * off, and not read yet. Collapsing "not read" into "off" hides the Plan tests
 * action on every repo connected before this ran; collapsing it into "on"
 * offers a button whose only effect is a refusal.
 */

const reader = (files: Record<string, { content: string; sha: string }>) =>
  ({
    getFileAtRef: async (_o: string, _r: string, path: string) => files[path] ?? null,
  }) as unknown as RepoReader;

const POLICY = ".github/factory-testing.json";

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
  const read = async () => (await db.select().from(repos).where(eq(repos.id, repo.id)).limit(1))[0]!;
  return {
    db,
    read,
    repoRef: { id: repo.id, orgId: org.id, estateId: estate.id, fullName: "acme/api", defaultBranch: "main", stagingBranch: null },
  };
}

describe("importTestingPolicy", () => {
  it("starts as unread, not as off", async () => {
    const { read } = await seed();
    expect((await read()).systemTests).toBeNull();
  });

  it("mirrors an enabled policy with its mode", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(db, repoRef, reader({ [POLICY]: { content: '{"system_tests": true}', sha: "a" } }));
    const row = await read();
    expect(row.systemTests).toBe(true);
    expect(row.testMode).toBe("gate");
  });

  it("mirrors advisory mode", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(
      db,
      repoRef,
      reader({ [POLICY]: { content: '{"system_tests": true, "mode": "advisory"}', sha: "a" } }),
    );
    expect((await read()).testMode).toBe("advisory");
  });

  it("records an absent file as off — that is what absent means", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(db, repoRef, reader({}));
    expect((await read()).systemTests).toBe(false);
  });

  it("records a policy that turns tests off", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(db, repoRef, reader({ [POLICY]: { content: '{"system_tests": false}', sha: "a" } }));
    expect((await read()).systemTests).toBe(false);
  });

  it("keeps the last good answer when the file is malformed", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(db, repoRef, reader({ [POLICY]: { content: '{"system_tests": true}', sha: "a" } }));
    await importTestingPolicy(db, repoRef, reader({ [POLICY]: { content: "{not json", sha: "b" } }));
    // A file somebody is mid-edit does not turn a working policy off.
    expect((await read()).systemTests).toBe(true);
  });

  it("keeps the last good answer when GitHub is unreachable", async () => {
    const { db, read, repoRef } = await seed();
    await importTestingPolicy(db, repoRef, reader({ [POLICY]: { content: '{"system_tests": true}', sha: "a" } }));
    await importTestingPolicy(db, repoRef, {
      getFileAtRef: async () => {
        throw new Error("502");
      },
    } as unknown as RepoReader);
    expect((await read()).systemTests).toBe(true);
  });
});
