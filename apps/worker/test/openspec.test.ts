import { estates, onboardingRuns, orgs, repos, type Db } from "@console/db";
import { loadConfig, type AppAuth } from "@console/core";
import { eq } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runOpenspecInit, type OpenspecRepoClient } from "../src/openspec.js";
import { testDb } from "./helpers.js";

/**
 * The openspec job against an in-memory GitHub: scaffold injection replaces
 * npx, a fake client replaces the REST API. What's asserted is the contract —
 * idempotence, branch/PR creation, content-identical skips, step recording.
 */

const cfg = loadConfig({ OPENSPEC_VERSION: "1.8.0" } as NodeJS.ProcessEnv);
const auth = null as unknown as AppAuth; // never touched: a client is always injected

class FakeGitHub implements OpenspecRepoClient {
  branches = new Map<string, Map<string, string>>(); // branch -> path -> content
  pulls: Array<{ number: number; state: string; head: { ref: string }; html_url: string; title: string }> = [];
  putCount = 0;

  constructor(defaultBranchFiles: Record<string, string> = {}) {
    this.branches.set("main", new Map(Object.entries(defaultBranchFiles)));
  }

  private files(ref?: string): Map<string, string> {
    return this.branches.get(ref ?? "main") ?? new Map();
  }

  async listDir(_o: string, _r: string, path: string, ref?: string) {
    return [...this.files(ref).keys()]
      .filter((p) => p.startsWith(`${path}/`))
      .map((p) => ({ path: p, type: "file", sha: "x" }));
  }

  async getFileAtRef(_o: string, _r: string, path: string, ref?: string) {
    const content = this.files(ref).get(path);
    return content === undefined ? null : { content, sha: `sha-${path}` };
  }

  async getBranchHeadSha(_o: string, _r: string, branch: string) {
    return this.branches.has(branch) ? `head-${branch}` : null;
  }

  async createBranch(_o: string, _r: string, branch: string) {
    this.branches.set(branch, new Map(this.branches.get("main")));
  }

  async putFile(_o: string, _r: string, path: string, opts: { content: string; branch: string }) {
    this.putCount++;
    this.files(opts.branch).set(path, opts.content);
  }

  async createPull(_o: string, _r: string, opts: { title: string; head: string; base: string }) {
    const existing = this.pulls.find((p) => p.state === "open" && p.head.ref === opts.head);
    if (existing) {
      const { GitHubHttpError } = await import("@console/core");
      throw new GitHubHttpError(422, "POST", "/pulls", "A pull request already exists");
    }
    const pr = { number: this.pulls.length + 1, state: "open", head: { ref: opts.head }, html_url: `https://gh/pr/${this.pulls.length + 1}`, title: opts.title };
    this.pulls.push(pr);
    return pr;
  }

  async listPulls() {
    return this.pulls;
  }
}

const scaffold = async (dir: string) => {
  await mkdir(join(dir, "openspec"), { recursive: true });
  await mkdir(join(dir, ".claude/commands/opsx"), { recursive: true });
  await writeFile(join(dir, "openspec/config.yaml"), "schema: spec-driven\n");
  await writeFile(join(dir, ".claude/commands/opsx/propose.md"), "# propose\n");
};

let db: Db;
let repoId: string;

beforeEach(async () => {
  ({ db } = await testDb());
  const [org] = await db.insert(orgs).values({ name: "acme" }).returning();
  const [estate] = await db.insert(estates).values({ orgId: org!.id, name: "acme", installationId: 1 }).returning();
  const [repo] = await db
    .insert(repos)
    .values({ orgId: org!.id, estateId: estate!.id, ghNodeId: "R_1", fullName: "acme/app", defaultBranch: "main" })
    .returning();
  repoId = repo!.id;
});

async function stepRow() {
  return (await db.select().from(onboardingRuns).where(eq(onboardingRuns.repoId, repoId)))[0];
}

describe("runOpenspecInit", () => {
  it("scaffolds, pushes to the enablement branch and opens the PR", async () => {
    const gh = new FakeGitHub();
    const result = await runOpenspecInit(db, cfg, auth, { repoId }, { scaffold, client: gh });

    expect(result).toEqual({ found: false, pushed: 2, skipped: 0 });
    expect(gh.branches.get("factory-console/enable-factory")?.get("openspec/config.yaml")).toBe("schema: spec-driven\n");
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]!.title).toBe("Initialise OpenSpec");

    const row = await stepRow();
    expect(row?.step).toBe("openspec");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toMatchObject({ pushed: 2, prNumber: 1 });
  });

  it("is a no-op when openspec/ already exists on the default branch", async () => {
    const gh = new FakeGitHub({ "openspec/config.yaml": "schema: spec-driven\n" });
    const result = await runOpenspecInit(db, cfg, auth, { repoId }, { scaffold, client: gh });

    expect(result).toEqual({ found: true, pushed: 0, skipped: 0 });
    expect(gh.putCount).toBe(0);
    expect(gh.pulls).toHaveLength(0);
    expect((await stepRow())?.detail).toMatchObject({ found: true });
  });

  it("forced re-run adds only the scaffold files the repo is missing", async () => {
    // Set up against an older CLI: openspec/ exists but the opsx commands the
    // newer scaffold ships do not. The plain re-run says "nothing to do"; the
    // forced one is how the repo catches up.
    const gh = new FakeGitHub({ "openspec/config.yaml": "schema: spec-driven\n# hand-edited context\n" });
    const result = await runOpenspecInit(db, cfg, auth, { repoId, force: true }, { scaffold, client: gh });

    expect(result.pushed).toBe(1);
    const synced = gh.branches.get("factory-console/sync-openspec");
    expect(synced?.get(".claude/commands/opsx/propose.md")).toBe("# propose\n");
    // The hand-edited file it already had is untouched — a re-run must not
    // quietly revert local edits.
    expect(synced?.get("openspec/config.yaml")).toBe("schema: spec-driven\n# hand-edited context\n");
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]!.title).toBe("Sync the OpenSpec scaffold");
    expect(gh.pulls[0]!.head.ref).toBe("factory-console/sync-openspec");
  });

  it("forced re-run with nothing missing opens no PR", async () => {
    const gh = new FakeGitHub({
      "openspec/config.yaml": "schema: spec-driven\n",
      ".claude/commands/opsx/propose.md": "# propose\n",
    });
    const result = await runOpenspecInit(db, cfg, auth, { repoId, force: true }, { scaffold, client: gh });

    expect(result.pushed).toBe(0);
    expect(gh.pulls).toHaveLength(0); // an empty PR would 422 on "No commits between"
    expect((await stepRow())?.detail).toMatchObject({ inSync: true });
  });

  it("skips content-identical files and reuses the open PR on re-run", async () => {
    const gh = new FakeGitHub();
    await runOpenspecInit(db, cfg, auth, { repoId }, { scaffold, client: gh });
    const result = await runOpenspecInit(db, cfg, auth, { repoId }, { scaffold, client: gh });

    expect(result).toEqual({ found: false, pushed: 0, skipped: 2 });
    expect(gh.pulls).toHaveLength(1); // 422 path found the existing PR
    expect((await stepRow())?.detail).toMatchObject({ skipped: 2, prNumber: 1 });
  });

  it("drops a seeded CLAUDE.md the scaffold left untouched", async () => {
    const gh = new FakeGitHub({ "CLAUDE.md": "# house rules\n" });
    const result = await runOpenspecInit(db, cfg, auth, { repoId }, { scaffold, client: gh });

    expect(result.pushed).toBe(2); // config.yaml + propose.md, no CLAUDE.md
    expect(gh.branches.get("factory-console/enable-factory")?.get("CLAUDE.md")).toBe("# house rules\n");
  });

  it("records a failed step when the scaffold produces nothing", async () => {
    const gh = new FakeGitHub();
    await expect(
      runOpenspecInit(db, cfg, auth, { repoId }, { scaffold: async () => undefined, client: gh }),
    ).rejects.toThrow(/produced no files/);
    expect((await stepRow())?.status).toBe("failed");
  });
});
