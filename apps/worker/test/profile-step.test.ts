import { estates, onboardingRuns, orgs, repos } from "@console/db";
import type { GhPull, GhWorkflowRun, RepoReader } from "@console/core";
import { describe, expect, it } from "vitest";
import { refreshRepoProfile, repairProfileStep, updateProfileStepFromPull, updateProfileStepFromRun } from "../src/artifacts.js";
import { testDb } from "./helpers.js";

/**
 * The profile onboarding step is finished by a merge in GitHub, not by anything
 * the Console does — it asks the Profiler for a draft and then waits. These are
 * the places its answer, its progress and its failures arrive: the profiler's
 * PR on `factory/profile`, the pipeline run carrying it, and finally the
 * profile file landing on the default branch.
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

/** Seed the step exactly as the API's profile route records it. */
async function seedStep(
  db: Awaited<ReturnType<typeof seed>>["db"],
  repoRef: Awaited<ReturnType<typeof seed>>["repoRef"],
  status = "pending",
  detail: Record<string, unknown> = {},
) {
  await db.insert(onboardingRuns).values({
    orgId: repoRef.orgId,
    estateId: repoRef.estateId,
    repoId: repoRef.id,
    step: "profile",
    status,
    detail: {
      issueNumber: 7,
      issueUrl: "https://github.com/acme/api/issues/7",
      requestedAt: "2026-08-17T10:00:00.000Z",
      ...detail,
    },
    updatedAt: new Date(),
  });
}

const pull = (over: Partial<GhPull> = {}): GhPull =>
  ({
    id: 1,
    node_id: "PR_1",
    number: 12,
    title: "chore(factory): repo profile",
    state: "open",
    draft: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: "factory/profile", sha: "h1" },
    base: { ref: "main" },
    user: { login: "claude[bot]" },
    updated_at: "2026-08-17T10:05:00Z",
    html_url: "https://github.com/acme/api/pull/12",
    ...over,
  }) as GhPull;

const run = (over: Partial<GhWorkflowRun> = {}): GhWorkflowRun =>
  ({
    id: 900,
    node_id: "WR_900",
    name: "Factory pipeline",
    status: "completed",
    conclusion: "failure",
    event: "issues",
    head_branch: "main",
    html_url: "https://github.com/acme/api/actions/runs/900",
    created_at: "2026-08-17T10:01:00Z",
    updated_at: "2026-08-17T10:04:00Z",
    ...over,
  }) as GhWorkflowRun;

const step = async (db: Awaited<ReturnType<typeof seed>>["db"]) => (await db.select().from(onboardingRuns))[0];

describe("updateProfileStepFromPull", () => {
  it("records the correction PR on the pending step", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await updateProfileStepFromPull(db, repoRef, pull());

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    expect(s!.detail).toMatchObject({
      prNumber: 12,
      prUrl: "https://github.com/acme/api/pull/12",
      prState: "open",
      issueNumber: 7, // accumulated, not replaced
    });
  });

  it("supersedes an attributed run failure once the PR arrives", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef, "failed", { error: "the Actions run carrying the Profiler did not finish" });

    await updateProfileStepFromPull(db, repoRef, pull());

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    expect(s!.detail).not.toHaveProperty("error");
  });

  it("closes the step when the PR merges", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef, "pending", { prNumber: 12, prState: "open" });

    await updateProfileStepFromPull(db, repoRef, pull({ state: "closed", merged_at: "2026-08-17T11:00:00Z" }));

    expect(await step(db)).toMatchObject({ status: "ok" });
    expect((await step(db))!.detail).toMatchObject({ prState: "merged" });
  });

  it("marks a PR closed without merging so the card can say so", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef, "pending", { prNumber: 12, prState: "open" });

    await updateProfileStepFromPull(db, repoRef, pull({ state: "closed" }));

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    expect(s!.detail).toMatchObject({ prState: "closed" });
  });

  it("ignores PRs on other branches, and repos that never ran the step", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);
    await updateProfileStepFromPull(db, repoRef, pull({ head: { ref: "factory/12-spec", sha: "x" } }));
    expect((await step(db))!.detail).not.toHaveProperty("prNumber");

    const fresh = await seed();
    await updateProfileStepFromPull(fresh.db, fresh.repoRef, pull());
    expect(await fresh.db.select().from(onboardingRuns)).toHaveLength(0);
  });
});

describe("updateProfileStepFromRun", () => {
  it("fails the step when the attributed run dies, keeping the log link", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await updateProfileStepFromRun(db, repoRef, run());

    const s = await step(db);
    expect(s).toMatchObject({ status: "failed" });
    expect(s!.detail).toMatchObject({
      error: expect.stringContaining("did not finish"),
      run: { id: 900, htmlUrl: "https://github.com/acme/api/actions/runs/900", conclusion: "failure" },
    });
  });

  it("shows a live run without failing anything", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await updateProfileStepFromRun(db, repoRef, run({ status: "in_progress", conclusion: null }));

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    expect(s!.detail).toMatchObject({ run: { status: "in_progress" } });
  });

  it("recovers a failed step when a newer attributed run succeeds", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef, "failed", { error: "x", run: { id: 900, htmlUrl: "u", status: "completed", conclusion: "failure", createdAt: "2026-08-17T10:01:00Z" } });

    await updateProfileStepFromRun(db, repoRef, run({ id: 901, conclusion: "success", created_at: "2026-08-17T10:10:00Z" }));

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    expect(s!.detail).not.toHaveProperty("error");
  });

  it("attributes nothing outside the window: old runs, wrong events, delivered steps", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    // Started before the Console asked — some earlier pipeline business.
    await updateProfileStepFromRun(db, repoRef, run({ created_at: "2026-08-17T09:00:00Z" }));
    // Wrong event: profiler never arrives on pull_request runs.
    await updateProfileStepFromRun(db, repoRef, run({ event: "pull_request" }));
    expect(await step(db)).toMatchObject({ status: "pending" });
    expect((await step(db))!.detail).not.toHaveProperty("run");

    // PR already open: later red runs are other roles' work.
    const { db: db2, repoRef: r2 } = await seed();
    await seedStep(db2, r2, "pending", { prNumber: 12, prState: "open" });
    await updateProfileStepFromRun(db2, r2, run());
    expect(await step(db2)).toMatchObject({ status: "pending" });
  });

  it("ignores steps recorded before requestedAt existed", async () => {
    const { db, repoRef } = await seed();
    await db.insert(onboardingRuns).values({
      orgId: repoRef.orgId,
      estateId: repoRef.estateId,
      repoId: repoRef.id,
      step: "profile",
      status: "pending",
      detail: { issueNumber: 7 }, // legacy shape
      updatedAt: new Date(),
    });

    await updateProfileStepFromRun(db, repoRef, run());
    expect(await step(db)).toMatchObject({ status: "pending" });
  });
});

describe("repairProfileStep", () => {
  it("repairs a step stuck at 'waiting for the run to start' after every webhook was missed", async () => {
    // The insurance-app-base incident: the Profiler's run fired, opened its
    // correction PR and then went red on the turn limit — but no workflow_run
    // or pull_request delivery reached the Console, so the card never moved.
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await repairProfileStep(db, repoRef, [pull()], [run()]);

    const s = await step(db);
    expect(s).toMatchObject({ status: "pending" });
    // The PR supersedes the attributed failure; the run link stays for the curious.
    expect(s!.detail).toMatchObject({ prNumber: 12, prState: "open", run: { id: 900, conclusion: "failure" } });
    expect(s!.detail).not.toHaveProperty("error");
  });

  it("surfaces an attributed failure when no PR ever arrived", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await repairProfileStep(db, repoRef, [], [run()]);

    const s = await step(db);
    expect(s).toMatchObject({ status: "failed" });
    expect(s!.detail).toMatchObject({ error: expect.stringContaining("did not finish") });
  });

  it("prefers the open PR over an older closed one instead of replaying history", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef);

    await repairProfileStep(
      db,
      repoRef,
      [
        pull({ number: 9, state: "closed", updated_at: "2026-08-17T09:00:00Z", html_url: "https://github.com/acme/api/pull/9" }),
        pull(),
      ],
      [],
    );

    expect((await step(db))!.detail).toMatchObject({ prNumber: 12, prState: "open" });
  });

  it("does nothing on repos that never ran the step", async () => {
    const { db, repoRef } = await seed();
    await repairProfileStep(db, repoRef, [pull()], [run()]);
    expect(await db.select().from(onboardingRuns)).toHaveLength(0);
  });
});

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

  it("keeps the accumulated links and flips the open PR to merged when the file lands", async () => {
    const { db, repoRef } = await seed();
    await seedStep(db, repoRef, "pending", { prNumber: 12, prUrl: "https://github.com/acme/api/pull/12", prState: "open" });

    await refreshRepoProfile(db, repoRef, reader({ ".factory/profile.json": PROFILE, ".github/workflows/factory-pipeline.yml": STUB }));

    const s = (await db.select().from(onboardingRuns))[0]!;
    expect(s).toMatchObject({ status: "ok" });
    expect(s.detail).toMatchObject({
      sha: "p1",
      prState: "merged",
      prUrl: "https://github.com/acme/api/pull/12",
      issueUrl: "https://github.com/acme/api/issues/7",
    });
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
