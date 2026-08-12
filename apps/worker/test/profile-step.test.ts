import { estates, onboardingRuns, orgs, repos } from "@console/db";
import type { RepoReader } from "@console/core";
import { describe, expect, it } from "vitest";
import { refreshRepoProfile } from "../src/artifacts.js";
import { testDb } from "./helpers.js";

/**
 * The profile onboarding step is finished by a merge in GitHub, not by anything
 * the Console does — it asks the Profiler for a draft and then waits. This is
 * where that answer arrives.
 */

const reader = (files: Record<string, { content: string; sha: string }>) =>
  ({
    getFileAtRef: async (_o: string, _r: string, path: string) => files[path] ?? null,
  }) as unknown as RepoReader;

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
  return { db, repoRef: { id: repo.id, orgId: org.id, estateId: estate.id, fullName: "acme/api", defaultBranch: "main" } };
}

const PROFILE = { content: JSON.stringify({ repo: "acme/api", branches: { staging: "staging" } }), sha: "p1" };
const STUB = { content: "permissions:\n", sha: "s1" };

describe("refreshRepoProfile", () => {
  it("closes the profile step and enables the repo when the profile lands", async () => {
    const { db, repoRef } = await seed();
    await refreshRepoProfile(db, repoRef, reader({ ".factory/profile.json": PROFILE, ".github/workflows/factory-pipeline.yml": STUB }));

    const repo = (await db.select().from(repos))[0]!;
    expect(repo).toMatchObject({ profileSha: "p1", stagingBranch: "staging", factoryEnabled: true });
    const step = (await db.select().from(onboardingRuns))[0];
    expect(step).toMatchObject({ step: "profile", status: "ok" });
  });

  it("leaves the step alone while the PR is still open", async () => {
    const { db, repoRef } = await seed();
    await refreshRepoProfile(db, repoRef, reader({ ".github/workflows/factory-pipeline.yml": STUB }));

    // Nothing to report yet: the step stays pending from the API's side, and a
    // repo without a profile is not factory-enabled however many stubs it has.
    expect(await db.select().from(onboardingRuns)).toHaveLength(0);
    expect((await db.select().from(repos))[0]).toMatchObject({ factoryEnabled: false, profileSha: null });
  });

  it("does not undo a finished step when a later sync cannot read the file", async () => {
    const { db, repoRef } = await seed();
    await refreshRepoProfile(db, repoRef, reader({ ".factory/profile.json": PROFILE, ".github/workflows/factory-pipeline.yml": STUB }));
    await refreshRepoProfile(db, repoRef, reader({ ".github/workflows/factory-pipeline.yml": STUB }));

    // A profile that disappears is the validation suite's story to tell — this
    // job flipping the step back to pending would read as "the Console lost it".
    expect((await db.select().from(onboardingRuns))[0]).toMatchObject({ status: "ok" });
  });
});
