import { encryptSecret, parseApproverFile, parseChangePath, type RepoReader } from "@console/core";
import {
  artifactCache,
  changeArtifacts,
  changes,
  gateAssignments,
  issues,
  onboardingRuns,
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

/** Refresh profile-derived repo facts: staging branch, factory enablement. */
export async function refreshRepoProfile(db: Db, repo: RepoRef, reader: RepoReader): Promise<void> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const profile = await reader.getFileAtRef(owner, name, ".factory/profile.json");
  const stub = await reader.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
  let stagingBranch: string | null = null;
  if (profile) {
    try {
      const json = JSON.parse(profile.content) as { branches?: { staging?: string | null } };
      stagingBranch = json.branches?.staging ?? null;
    } catch {
      /* malformed profile — validation suite's problem */
    }
  }
  await db
    .update(repos)
    .set({
      profileSha: profile?.sha ?? null,
      stagingBranch,
      factoryEnabled: Boolean(profile && stub),
      lastSyncedAt: new Date(),
    })
    .where(eq(repos.id, repo.id));

  // The profile step is finished by a merge in GitHub, not by anything the
  // Console does: it asks the Profiler for a draft and then waits. This is the
  // moment that answer arrives, so close the step here rather than making the
  // onboarding page poll for a file it already fetches. Only ever marked ok —
  // a profile that later disappears is the validation suite's story to tell.
  if (profile) {
    await db
      .insert(onboardingRuns)
      .values({
        orgId: repo.orgId,
        estateId: repo.estateId,
        repoId: repo.id,
        step: "profile",
        status: "ok",
        detail: { sha: profile.sha },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [onboardingRuns.repoId, onboardingRuns.step],
        set: { status: "ok", detail: { sha: profile.sha }, updatedAt: new Date() },
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
