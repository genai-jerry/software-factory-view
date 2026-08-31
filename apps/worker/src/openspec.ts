import { InstallationClient, GitHubHttpError, type AppAuth, type ConsoleConfig } from "@console/core";
import { estates, onboardingRuns, repos, type Db } from "@console/db";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Onboarding step 3 (spec 03): initialise OpenSpec without the user touching a
 * terminal. The worker runs the real CLI in a scratch directory — so the
 * scaffold is exactly what upstream ships, never a vendored copy — and pushes
 * the resulting files onto the enablement branch under the installation token.
 * The scaffold therefore rides the same human-merged PR that turns the factory
 * on: the app automates setup; only humans merge.
 */

export interface OpenspecJob {
  repoId: string;
  /**
   * An operator asked for a re-run on a repo that already has `openspec/`.
   * Skips the "nothing to do" shortcut and pushes the scaffold files this
   * repo is MISSING (see the write loop) — never over one it already has.
   */
  force?: boolean;
}

/** Same branch as the stub-files step, so both land in one enablement PR. */
const ENABLE_BRANCH = "factory-console/enable-factory";
/** A forced re-run keeps its own branch: the enablement PR is long merged. */
const SYNC_BRANCH = "factory-console/sync-openspec";

/** Ports the job needs; InstallationClient satisfies this structurally. */
export interface OpenspecRepoClient {
  listDir(owner: string, repo: string, path: string, ref?: string): Promise<Array<{ path: string; type: string; sha: string }>>;
  getFileAtRef(owner: string, repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null>;
  getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null>;
  createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void>;
  putFile(owner: string, repo: string, path: string, opts: { message: string; content: string; branch: string; sha?: string }): Promise<void>;
  createPull(owner: string, repo: string, opts: { title: string; head: string; base: string; body: string }): Promise<{ number: number; html_url: string }>;
  listPulls(owner: string, repo: string, page?: number): Promise<Array<{ number: number; state: string; head: { ref: string }; html_url: string }>>;
}

export interface OpenspecOverrides {
  /** Populate `dir` with the OpenSpec scaffold; defaults to running the real CLI via npx. */
  scaffold?: (dir: string, version: string) => Promise<void>;
  client?: OpenspecRepoClient;
}

export async function runOpenspecInit(
  db: Db,
  cfg: ConsoleConfig,
  auth: AppAuth,
  job: OpenspecJob,
  overrides: OpenspecOverrides = {},
): Promise<{ found: boolean; pushed: number; skipped: number }> {
  const repo = (await db.select().from(repos).where(eq(repos.id, job.repoId)).limit(1))[0];
  if (!repo) throw new Error(`openspec job: repo ${job.repoId} not found`);
  const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
  if (!estate) throw new Error(`openspec job: estate ${repo.estateId} not found`);
  const client = overrides.client ?? new InstallationClient(cfg.GITHUB_API_URL, auth, estate.installationId);
  const scaffold = overrides.scaffold ?? scaffoldWithNpx;
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const version = cfg.OPENSPEC_VERSION;

  await recordOpenspecStep(db, repo, "running", { version });
  try {
    // Idempotence: already initialised on the default branch means nothing to
    // do — unless an operator explicitly re-ran the step, which is how a repo
    // set up against an older CLI picks up scaffold files added since.
    const existing = await client.listDir(owner, name, "openspec");
    const initialised = existing.length > 0;
    if (initialised && !job.force) {
      await recordOpenspecStep(db, repo, "ok", { found: true });
      return { found: true, pushed: 0, skipped: 0 };
    }
    const branch = initialised ? SYNC_BRANCH : ENABLE_BRANCH;

    const dir = await mkdtemp(join(tmpdir(), "openspec-init-"));
    let files: Map<string, string>;
    try {
      // Seed the repo's CLAUDE.md so a CLI version that appends managed markers
      // appends to the real file instead of fabricating a fresh one.
      const seededClaudeMd = await client.getFileAtRef(owner, name, "CLAUDE.md");
      if (seededClaudeMd) await writeFile(join(dir, "CLAUDE.md"), seededClaudeMd.content, "utf8");

      await scaffold(dir, version);

      files = await collectFiles(dir);
      if (seededClaudeMd && files.get("CLAUDE.md") === seededClaudeMd.content) files.delete("CLAUDE.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (files.size === 0) throw new Error(`openspec@${version} init produced no files`);

    const headSha = await client.getBranchHeadSha(owner, name, repo.defaultBranch);
    if (!headSha) throw new Error(`cannot resolve head of ${repo.defaultBranch}`);
    if (!(await client.getBranchHeadSha(owner, name, branch))) {
      await client.createBranch(owner, name, branch, headSha);
    }

    let pushed = 0;
    let skipped = 0;
    for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const current = await client.getFileAtRef(owner, name, path, branch);
      if (current?.content === content) {
        skipped++;
        continue;
      }
      // A forced re-run is additive: it fills in scaffold files this repo does
      // not have and never rewrites one it does. Re-running to "refresh" must
      // not quietly revert a hand-edited openspec/config.yaml — the operator
      // asked for the newer scaffold, not for their edits back.
      if (initialised && current) {
        skipped++;
        continue;
      }
      await client.putFile(owner, name, path, {
        message: `factory: add ${path} (openspec@${version} init)`,
        content,
        branch,
        sha: current?.sha,
      });
      pushed++;
    }

    // A forced re-run that found nothing missing has no commits to open a PR
    // against — GitHub would 422 on "No commits between". Say so instead. The
    // enablement path still always asks: pushing nothing there means the files
    // were already on the branch, and its PR link has to survive the re-run.
    const pr =
      !initialised || pushed > 0
        ? await ensurePull(client, owner, name, repo.defaultBranch, version, branch)
        : null;
    await recordOpenspecStep(db, repo, "ok", {
      found: initialised && pushed === 0,
      pushed,
      skipped,
      version,
      ...(initialised ? { inSync: pushed === 0 } : {}),
      ...(pr ? { prNumber: pr.number, prUrl: pr.html_url } : {}),
    });
    return { found: false, pushed, skipped };
  } catch (err) {
    await recordOpenspecStep(db, repo, "failed", { error: (err as Error).message, version });
    throw err;
  }
}

/** The real thing: the pinned upstream CLI in a scratch directory, telemetry off. */
async function scaffoldWithNpx(dir: string, version: string): Promise<void> {
  await execFileAsync("npx", ["-y", `@fission-ai/openspec@${version}`, "init", "--tools", "claude"], {
    cwd: dir,
    timeout: 5 * 60 * 1000,
    env: { ...process.env, OPENSPEC_TELEMETRY: "0", CI: "1" },
  });
}

/** Everything the scaffold wrote, path → utf8 content. Empty dirs are unrepresentable in git anyway. */
async function collectFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const rel = relative(root, abs);
    if (rel.startsWith("node_modules/") || rel.startsWith(".git/")) continue;
    out.set(rel.split("\\").join("/"), await readFile(abs, "utf8"));
  }
  return out;
}

/** Open the enablement PR if the stubs step has not already; 422 means it exists. */
async function ensurePull(
  client: OpenspecRepoClient,
  owner: string,
  name: string,
  base: string,
  version: string,
  head: string = ENABLE_BRANCH,
): Promise<{ number: number; html_url: string } | null> {
  try {
    return await client.createPull(owner, name, {
      title: head === ENABLE_BRANCH ? "Initialise OpenSpec" : "Sync the OpenSpec scaffold",
      head,
      base,
      body: OPENSPEC_PR_BODY(version),
    });
  } catch (e) {
    if (e instanceof GitHubHttpError && e.status === 422) {
      const open = (await client.listPulls(owner, name)).find((p) => p.state === "open" && p.head.ref === head);
      return open ? { number: open.number, html_url: open.html_url } : null;
    }
    throw e;
  }
}

const OPENSPEC_PR_BODY = (version: string): string => `This PR carries the OpenSpec scaffold — the output of
\`npx -y @fission-ai/openspec@${version} init --tools claude\`, run by the Console's worker so nobody needs a local checkout:

- \`openspec/\` — config and the changes/specs directory structure the factory's intake, implementer and ops roles depend on.
- \`.claude/commands/opsx/*\` and \`.claude/skills/openspec-*\` — the \`/opsx:*\` commands and skills.

If the stub-files step has run, its files share this branch and this PR. Merging is the human act — the Console only automates the setup.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;

async function recordOpenspecStep(
  db: Db,
  repo: { id: string; orgId: string; estateId: string },
  status: "running" | "ok" | "failed",
  detail: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(onboardingRuns)
    .values({ orgId: repo.orgId, estateId: repo.estateId, repoId: repo.id, step: "openspec", status, detail, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [onboardingRuns.repoId, onboardingRuns.step],
      set: { status, detail, updatedAt: new Date() },
    });
}
