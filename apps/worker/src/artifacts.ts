import { encryptSecret, parseApproverFile, parseChangePath, repoHasFactoryEngine, type GhComment, type GhIssue, type GhPull, type GhWorkflowRun, type RepoReader } from "@console/core";
import {
  artifactCache,
  changeArtifacts,
  changes,
  gateAssignments,
  issues,
  onboardingRuns,
  orgs,
  pullRequests,
  repos,
  taskDependencies,
  type Db,
} from "@console/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { RepoRef } from "./project.js";

/**
 * Artifact plumbing: the change folder as an entity, cached immutably per
 * (repo, path, sha) with content encrypted at rest (spec 01 §2.3). Both refs
 * are tracked — "as proposed" (document-PR head) and "as approved" (default
 * branch) — because the gate panel diffs them.
 */

export async function cacheArtifact(
  db: Db,
  repo: RepoRef,
  reader: RepoReader,
  path: string,
  ref: string,
  masterKey: string,
): Promise<string | null> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const file = await reader.getFileAtRef(owner, name, path, ref);
  if (!file) return null;
  await db
    .insert(artifactCache)
    .values({
      orgId: repo.orgId,
      repoId: repo.id,
      path,
      commitSha: file.sha,
      encryptedContent: encryptSecret(file.content, masterKey),
      fetchedAt: new Date(),
    })
    .onConflictDoNothing({ target: [artifactCache.repoId, artifactCache.path, artifactCache.commitSha] });
  return file.sha;
}

/**
 * Discover and refresh the OpenSpec change folder for an epic. Discovery
 * prefers the spec/design PR file lists (spec 02 §1: "discovered from spec-PR
 * file lists"); the directory listing fallback covers epics whose PRs have
 * merged and gone.
 */
export async function refreshEpicArtifacts(
  db: Db,
  repo: RepoRef,
  reader: RepoReader,
  epicIssueId: string,
  epicNumber: number,
  masterKey: string,
): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];

  // Collect candidate artifact paths from the epic's document PRs.
  const docPrs = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, epicNumber)));

  const paths = new Map<string, { slug: string; kind: string }>();
  let branchRef: string | null = null;
  for (const pr of docPrs) {
    if (pr.kind !== "spec" && pr.kind !== "design") continue;
    if (pr.state === "open") branchRef = pr.headRef;
    try {
      const files = await reader.listPullFiles(owner, name, pr.number);
      for (const f of files) {
        const parsed = parseChangePath(f.filename);
        if (parsed && parsed.epicNumber === epicNumber && parsed.artifact) {
          paths.set(f.filename, { slug: parsed.slug, kind: parsed.artifact });
        }
      }
    } catch {
      // PR files unavailable (e.g. deleted branch) — fall through to dir listing
    }
  }

  // Fallback: list openspec/changes/ and match the epic number prefix.
  if (paths.size === 0) {
    const dirs = await reader.listDir(owner, name, "openspec/changes");
    const dir = dirs.find((d) => d.type === "dir" && d.path.match(new RegExp(`/${epicNumber}-[^/]+$`)));
    if (dir) {
      const files = await reader.listDir(owner, name, dir.path);
      for (const f of files) {
        if (f.type === "file") {
          const parsed = parseChangePath(f.path);
          if (parsed?.artifact) paths.set(f.path, { slug: parsed.slug, kind: parsed.artifact });
        } else if (f.type === "dir" && f.path.endsWith("/specs")) {
          for (const s of await reader.listDir(owner, name, f.path)) {
            const parsed = parseChangePath(s.path);
            if (parsed?.artifact) paths.set(s.path, { slug: parsed.slug, kind: parsed.artifact });
          }
        }
      }
    }
  }

  if (paths.size === 0) return;
  const slug = paths.values().next().value!.slug;

  const changeRow =
    (
      await db
        .insert(changes)
        .values({ orgId: repo.orgId, estateId: repo.estateId, epicIssueId, slug })
        .onConflictDoNothing({ target: changes.epicIssueId })
        .returning()
    )[0] ?? (await db.select().from(changes).where(eq(changes.epicIssueId, epicIssueId)).limit(1))[0]!;

  for (const [path, meta] of paths) {
    const latestSha = branchRef ? await cacheArtifact(db, repo, reader, path, branchRef, masterKey) : null;
    const mergedSha = await cacheArtifact(db, repo, reader, path, repo.defaultBranch, masterKey);
    await db
      .insert(changeArtifacts)
      .values({
        orgId: repo.orgId,
        changeId: changeRow.id,
        repoId: repo.id,
        kind: meta.kind,
        path,
        latestSha: latestSha ?? mergedSha,
        mergedSha,
      })
      .onConflictDoUpdate({
        target: [changeArtifacts.changeId, changeArtifacts.repoId, changeArtifacts.path],
        set: { latestSha: latestSha ?? mergedSha, mergedSha },
      });
  }
}

/** Import factory-approvers.json into the gate_assignments mirror. The file wins on drift (spec 05 §4). */
export async function importGateAssignments(db: Db, repo: RepoRef, reader: RepoReader): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const file = await reader.getFileAtRef(owner, name, ".github/factory-approvers.json");
  if (!file) return;
  let parsed;
  try {
    parsed = parseApproverFile(JSON.parse(file.content));
  } catch {
    return; // malformed file — the validation suite reports it; the mirror keeps its last good state
  }
  await db.delete(gateAssignments).where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.repoId, repo.id)));
  for (const gate of ["spec", "design", "implementation", "release"] as const) {
    for (const login of parsed[gate]) {
      await db
        .insert(gateAssignments)
        .values({ estateId: repo.estateId, repoId: repo.id, gate, login, syncedFromSha: file.sha })
        .onConflictDoNothing();
    }
  }
}

/**
 * The Profiler's fixed working branch (commands/profiler.md in the factory
 * repo): its correction PR is always `factory/profile` → the default branch.
 * That constant is what lets webhook events be attributed to the profile
 * onboarding step without the Console ever reading the run's log.
 */
const PROFILE_BRANCH = "factory/profile";

/**
 * Events the profiler can arrive on: `issues` (the Console's label re-add, or
 * a human applying `factory:profile`) and `push` (the drift check). Everything
 * else — PRs, comments, dispatches — is some other role's run.
 */
const PROFILE_RUN_EVENTS = new Set(["issues", "push"]);

/** How the step's detail accumulates across webhooks. All keys optional. */
type ProfileStepDetail = {
  issueNumber?: number;
  issueUrl?: string;
  /** Stamped by the API route at the moment of the ask — the attribution window's left edge. */
  requestedAt?: string;
  run?: {
    id: number | string;
    htmlUrl: string;
    status: string;
    conclusion: string | null;
    createdAt: string;
    engine?: "github-actions" | "software-factory";
  };
  /** Live run marker (`factory:in-progress`) on the profile issue — no Actions run needed. */
  inProgress?: boolean;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  error?: string;
  [key: string]: unknown;
};

const AGENT_MARK = "<!-- factory-agent -->";
const IN_PROGRESS_LABEL = "factory:in-progress";
/** Orchestrator comments link `/runs/{id}` on PUBLIC_BASE_URL. */
const ORCHESTRATOR_RUN_URL = /https?:\/\/[^\s)<>]+\/runs\/[A-Za-z0-9-]+/;

function profileIssueMatches(detail: ProfileStepDetail, issueNumber: number): boolean {
  return detail.issueNumber === issueNumber;
}

function stepStillWaiting(row: { status: string }, detail: ProfileStepDetail): boolean {
  if (row.status !== "pending" && row.status !== "failed") return false;
  return detail.prState !== "open" && detail.prState !== "merged";
}

async function profileStepRow(db: Db, repoId: string) {
  return (
    await db
      .select()
      .from(onboardingRuns)
      .where(and(eq(onboardingRuns.repoId, repoId), eq(onboardingRuns.step, "profile")))
      .limit(1)
  )[0];
}

/**
 * The Profiler's PR is the step's deliverable, and this is where the Console
 * learns it exists — the profiler reports on the issue and in the PR, never
 * back to the Console. Head ref is the tell. Only repos that ran the step
 * through the Console have a row to update; drift-check PRs on repos onboarded
 * elsewhere stay invisible, which is correct — nobody is watching a wizard for
 * them.
 */
export async function updateProfileStepFromPull(db: Db, repo: RepoRef, pr: GhPull): Promise<void> {
  if (pr.head.ref !== PROFILE_BRANCH) return;
  const row = await profileStepRow(db, repo.id);
  if (!row) return;
  const detail = { ...(row.detail as ProfileStepDetail) };
  detail.prNumber = pr.number;
  detail.prUrl = pr.html_url;
  const merged = Boolean(pr.merged_at);
  detail.prState = merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  // A PR arriving supersedes an attributed run failure: whatever went red, the
  // Profiler delivered. The run link stays for the curious.
  delete detail.error;
  const status = merged || row.status === "ok" ? "ok" : "pending";
  await db.update(onboardingRuns).set({ status, detail, updatedAt: new Date() }).where(eq(onboardingRuns.id, row.id));
}

/**
 * Attribute a pipeline run to the pending profile step so its failure has
 * somewhere to land besides the Actions tab. Attribution is a window, not a
 * proof — the run payload for label events names no issue — so it is drawn
 * tight: only while the step is pending with no PR yet, only run events the
 * profiler arrives on, and only runs created after the Console asked. On an
 * already-enabled repo another issue's run can still slip in; the UI words the
 * failure as the run's, with its log one click away, rather than claiming to
 * know what died.
 */
export async function updateProfileStepFromRun(db: Db, repo: RepoRef, run: GhWorkflowRun): Promise<void> {
  if (!PROFILE_RUN_EVENTS.has(run.event)) return;
  const row = await profileStepRow(db, repo.id);
  if (!row || (row.status !== "pending" && row.status !== "failed")) return;
  const detail = { ...(row.detail as ProfileStepDetail) };
  if (detail.prState === "open" || detail.prState === "merged") return; // delivered — later runs are other work
  const requestedAt = typeof detail.requestedAt === "string" ? Date.parse(detail.requestedAt) : NaN;
  if (Number.isNaN(requestedAt)) return; // legacy row: no window to attribute within
  const createdAt = Date.parse(run.created_at);
  if (Number.isNaN(createdAt) || createdAt < requestedAt - 60_000) return; // predates the ask
  // Deliveries are unordered; keep the newest run, but always fold in updates
  // to the one already recorded (queued → in_progress → completed).
  if (detail.run && detail.run.id !== run.id && Date.parse(detail.run.createdAt) > createdAt) return;
  // An orchestrator start/fail comment is the live source under Software Factory;
  // a coincidental Actions run must not overwrite it.
  if (detail.run?.engine === "software-factory") return;
  detail.run = { id: run.id, htmlUrl: run.html_url, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, engine: "github-actions" };
  const failed = run.status === "completed" && ["failure", "timed_out", "cancelled", "startup_failure"].includes(run.conclusion ?? "");
  if (failed) {
    detail.error = "the Actions run carrying the Profiler did not finish — its log has the reason";
  } else {
    delete detail.error;
  }
  await db
    .update(onboardingRuns)
    .set({ status: failed ? "failed" : "pending", detail, updatedAt: new Date() })
    .where(eq(onboardingRuns.id, row.id));
}

/**
 * The Software Factory orchestrator has no `workflow_run`. Progress is the
 * `factory:in-progress` label it puts on the profile issue, then the start /
 * failure comment that links `/runs/{id}`. Same attribution window as Actions:
 * only the recorded profile issue, only while the step is still waiting.
 */
export async function updateProfileStepFromIssue(db: Db, repo: RepoRef, issue: GhIssue, action?: string, label?: string): Promise<void> {
  if (label !== IN_PROGRESS_LABEL) return;
  const row = await profileStepRow(db, repo.id);
  if (!row) return;
  const detail = { ...(row.detail as ProfileStepDetail) };
  if (!profileIssueMatches(detail, issue.number) || !stepStillWaiting(row, detail)) return;
  if (action === "unlabeled") {
    detail.inProgress = false;
    if (detail.run && detail.run.status !== "completed") {
      if (!detail.run.htmlUrl) {
        delete detail.run;
      } else if (detail.run.conclusion !== "failure") {
        detail.run = { ...detail.run, status: "completed", conclusion: detail.run.conclusion ?? "success" };
      }
    }
  } else {
    detail.inProgress = true;
    if (!detail.run) {
      // Marker without a log URL yet — the start comment usually follows in
      // the next delivery. Keep the card on "running" rather than "waiting".
      detail.run = {
        id: "in-progress",
        htmlUrl: "",
        status: "in_progress",
        conclusion: null,
        createdAt: issue.updated_at,
        engine: "software-factory",
      };
    } else if (detail.run.status !== "completed") {
      detail.run = { ...detail.run, status: "in_progress", engine: detail.run.engine ?? "software-factory" };
    }
    delete detail.error;
  }
  await db
    .update(onboardingRuns)
    .set({
      status: row.status === "failed" && action === "unlabeled" ? "failed" : "pending",
      detail,
      updatedAt: new Date(),
    })
    .where(eq(onboardingRuns.id, row.id));
}

export async function updateProfileStepFromComment(db: Db, repo: RepoRef, issue: GhIssue, comment: GhComment): Promise<void> {
  if (!comment.body.includes(AGENT_MARK)) return;
  const match = comment.body.match(ORCHESTRATOR_RUN_URL);
  if (!match) return;
  const htmlUrl = match[0];
  const runId = htmlUrl.split("/runs/").pop() ?? htmlUrl;
  const failed = /run failed/i.test(comment.body) || /open the run log/i.test(comment.body);
  const started = /is running/i.test(comment.body) || /watch the run/i.test(comment.body);
  if (!failed && !started) return;
  const row = await profileStepRow(db, repo.id);
  if (!row) return;
  const detail = { ...(row.detail as ProfileStepDetail) };
  if (!profileIssueMatches(detail, issue.number) || !stepStillWaiting(row, detail)) return;
  detail.run = {
    id: runId,
    htmlUrl,
    status: failed ? "completed" : "in_progress",
    conclusion: failed ? "failure" : null,
    createdAt: comment.created_at,
    engine: "software-factory",
  };
  detail.inProgress = !failed;
  if (failed) {
    detail.error = "the Software Factory Profiler did not finish — its run log has the reason";
  } else {
    delete detail.error;
  }
  await db
    .update(onboardingRuns)
    .set({ status: failed ? "failed" : "pending", detail, updatedAt: new Date() })
    .where(eq(onboardingRuns.id, row.id));
}

/**
 * Reconcile-time repair for the profile step. Webhooks are the primary path,
 * but a missed delivery used to be permanent: reconcile projected the
 * Profiler's runs and PRs into their tables without ever telling the
 * onboarding step, so the card sat at "waiting for the Profiler's Actions run
 * to start" while the correction PR waited on GitHub. Feed the walk results
 * through the same attribution functions the webhooks use — runs first, so an
 * attributed run (and its failure) is recorded before the PR arrives to
 * supersede it; a PR recorded first would make updateProfileStepFromRun treat
 * every run as some other role's work and drop the log link.
 */
export async function repairProfileStep(db: Db, repo: RepoRef, pulls: GhPull[], runs: GhWorkflowRun[]): Promise<void> {
  if (!(await profileStepRow(db, repo.id))) return;
  for (const run of runs) await updateProfileStepFromRun(db, repo, run);
  const profilePulls = pulls.filter((p) => p.head.ref === PROFILE_BRANCH);
  // One PR is the step's story. Prefer the open one (the review being waited
  // on); otherwise the most recently updated closed/merged one — replaying the
  // whole list would let an older closed PR overwrite the current state.
  const pick =
    profilePulls.find((p) => p.state === "open") ??
    profilePulls.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
  if (pick) await updateProfileStepFromPull(db, repo, pick);
}

/** Refresh profile-derived repo facts: integration branch, factory enablement. */
export async function refreshRepoProfile(db: Db, repo: RepoRef, reader: RepoReader): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const profile = await reader.getFileAtRef(owner, name, ".factory/profile.json");
  const stub = await reader.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
  const orchestratorFile = await reader.getFileAtRef(owner, name, ".github/factory-orchestrator.json");
  const branchPolicy = await reader.getFileAtRef(owner, name, ".github/factory-branches.json");
  // FACTORY.md §6a: the org's policy file names the integration branch and says
  // whether the step is mandatory; the profile overrides the NAME only, for a
  // repo whose branch is called something else. A missing policy file means the
  // defaults (staging, required) — not "no integration branch".
  let policyName: string | null = null;
  let stagingRequired = true;
  if (branchPolicy) {
    try {
      const json = JSON.parse(branchPolicy.content) as { staging?: string | null; required?: boolean };
      policyName = typeof json.staging === "string" && json.staging ? json.staging : null;
      stagingRequired = json.required !== false;
    } catch {
      /* malformed policy — validation suite's problem; keep the defaults */
    }
  }
  let profileOverride: string | null = null;
  if (profile) {
    try {
      const json = JSON.parse(profile.content) as { branches?: { staging?: string | null } };
      const v = json.branches?.staging;
      profileOverride = typeof v === "string" && v ? v : null;
    } catch {
      /* malformed profile — validation suite's problem */
    }
  }
  // Name resolution: profile override → repo policy file → the org's
  // configured default → "staging". The org setting only fills in when the
  // repo carries no policy file of its own — GitHub content stays
  // authoritative wherever it exists.
  let orgStaging: string | null = null;
  if (!branchPolicy && !profileOverride) {
    const org = (await db.select({ stagingBranch: orgs.stagingBranch }).from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0];
    orgStaging = org?.stagingBranch ?? null;
  }
  const stagingBranch = profileOverride ?? (stagingRequired ? policyName ?? orgStaging ?? "staging" : null);
  await db
    .update(repos)
    .set({
      profileSha: profile?.sha ?? null,
      stagingBranch,
      factoryEnabled: Boolean(
        profile &&
          repoHasFactoryEngine({ hasWorkflowStub: Boolean(stub), orchestratorFile: orchestratorFile?.content }),
      ),
      lastSyncedAt: new Date(),
    })
    .where(eq(repos.id, repo.id));

  // The profile step is finished by a merge in GitHub, not by anything the
  // Console does: it asks the Profiler for a draft and then waits. This is the
  // moment that answer arrives, so close the step here rather than making the
  // onboarding page poll for a file it already fetches. Only ever marked ok —
  // a profile that later disappears is the validation suite's story to tell.
  // Accumulated detail (issue, PR, run links) is kept: the file on the default
  // branch means whatever PR was open has merged, and an attributed run
  // failure is moot.
  if (profile) {
    const existing = await profileStepRow(db, repo.id);
    const detail = { ...((existing?.detail ?? {}) as ProfileStepDetail), sha: profile.sha };
    if (detail.prState === "open") detail.prState = "merged";
    delete detail.error;
    await db
      .insert(onboardingRuns)
      .values({
        orgId: repo.orgId,
        estateId: repo.estateId,
        repoId: repo.id,
        step: "profile",
        status: "ok",
        detail,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [onboardingRuns.repoId, onboardingRuns.step],
        set: { status: "ok", detail, updatedAt: new Date() },
      });
  }
}

/**
 * Repair `source='github'` dependency edges from the native issue-dependency
 * relations, delete-then-insert per issue so removed dependencies disappear.
 * Runs before projectIssue's body pass would matter: github rows own the
 * (blocked, blocker) pair, body rows only fill gaps. Blockers resolve by
 * node_id, so cross-repo dependencies work whenever both sides are projected;
 * a blocker in a repo not yet walked is skipped and converges next reconcile.
 */
export async function repairDependencies(db: Db, repo: RepoRef, reader: RepoReader): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const factoryIssues = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), isNotNull(issues.factoryState)));
  for (const issue of factoryIssues) {
    const blockedBy = await reader.listBlockedBy(owner, name, issue.number);
    await db
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.blockedIssueId, issue.id), eq(taskDependencies.source, "github")));
    for (const gh of blockedBy) {
      const blocker = (await db.select({ id: issues.id }).from(issues).where(eq(issues.ghNodeId, gh.node_id)).limit(1))[0];
      if (!blocker || blocker.id === issue.id) continue;
      await db
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.blockedIssueId, issue.id),
            eq(taskDependencies.blockerIssueId, blocker.id),
            eq(taskDependencies.source, "body"),
          ),
        );
      await db
        .insert(taskDependencies)
        .values({ orgId: repo.orgId, blockedIssueId: issue.id, blockerIssueId: blocker.id, source: "github" })
        .onConflictDoNothing({ target: [taskDependencies.blockedIssueId, taskDependencies.blockerIssueId] });
    }
  }
}

/** Repair parent links for task issues using the authoritative sub-issues API. */
export async function repairSubIssueLinks(db: Db, repo: RepoRef, reader: RepoReader): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const epics = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), eq(issues.kind, "epic")));
  for (const epic of epics) {
    const subs = await reader.listSubIssues(owner, name, epic.number);
    for (const sub of subs) {
      await db
        .update(issues)
        .set({ parentIssueId: epic.id, kind: "task" })
        .where(and(eq(issues.ghNodeId, sub.node_id), isNull(issues.parentIssueId)));
    }
  }
}
