import { InstallationClient, type AppAuth, type ConsoleConfig, type GhPull } from "@console/core";
import { estates, issues, repos, type Db } from "@console/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { projectComment, projectIssue, projectPull, projectRun, type RepoRef } from "./project.js";
import {
  importGateAssignments,
  importTestingPolicy,
  refreshEpicArtifacts,
  refreshRepoProfile,
  repairDependencies,
  repairProfileStep,
  repairSubIssueLinks,
} from "./artifacts.js";

/**
 * The reconciler (spec 01 §2.2): walk the GitHub API per estate and repair any
 * drift. This is what makes the read model rebuildable — drop the projection
 * tables, run this, and the Console is whole again. It reports a drift count;
 * a nightly count that stops being ~0 is the earliest signal of an ingestion bug.
 */

export interface ReconcileReport {
  estateId: string;
  reposWalked: number;
  issuesSeen: number;
  pullsSeen: number;
  errors: string[];
}

export async function reconcileEstate(db: Db, cfg: ConsoleConfig, auth: AppAuth, estateId: string): Promise<ReconcileReport> {
  const report: ReconcileReport = { estateId, reposWalked: 0, issuesSeen: 0, pullsSeen: 0, errors: [] };
  const estate = (await db.select().from(estates).where(eq(estates.id, estateId)).limit(1))[0];
  if (!estate) {
    report.errors.push("estate not found");
    return report;
  }
  const client = new InstallationClient(cfg.GITHUB_API_URL, auth, estate.installationId);
  const estateRepos = await db.select().from(repos).where(eq(repos.estateId, estateId));

  for (const repoRow of estateRepos) {
    const repoRef: RepoRef = {
      id: repoRow.id,
      orgId: repoRow.orgId,
      estateId: repoRow.estateId,
      fullName: repoRow.fullName,
      defaultBranch: repoRow.defaultBranch,
      stagingBranch: repoRow.stagingBranch,
    };
    const [owner, name] = repoRow.fullName.split("/") as [string, string];
    try {
      const gh = await client.getRepo(owner, name);
      if (gh.default_branch !== repoRow.defaultBranch) {
        await db.update(repos).set({ defaultBranch: gh.default_branch }).where(eq(repos.id, repoRow.id));
        repoRef.defaultBranch = gh.default_branch;
      }

      // Issues + their comments (comments only for factory-labelled issues, to bound API cost).
      for (let page = 1; page <= 10; page++) {
        const batch = await client.listIssues(owner, name, page);
        if (batch.length === 0) break;
        for (const issue of batch) {
          if (issue.pull_request) continue;
          report.issuesSeen++;
          await projectIssue(db, repoRef, issue);
        }
        if (batch.length < 100) break;
      }

      const factoryIssues = await db
        .select({ id: issues.id, number: issues.number, ghNodeId: issues.ghNodeId, kind: issues.kind })
        .from(issues)
        .where(and(eq(issues.repoId, repoRow.id), isNotNull(issues.factoryState)));
      for (const fi of factoryIssues) {
        const ghComments = await client.listIssueComments(owner, name, fi.number);
        for (const c of ghComments) await projectComment(db, repoRef, fi.ghNodeId, c);
      }

      const pulls: GhPull[] = [];
      for (let page = 1; page <= 5; page++) {
        const batch = await client.listPulls(owner, name, page);
        if (batch.length === 0) break;
        for (const pr of batch) {
          report.pullsSeen++;
          await projectPull(db, repoRef, pr);
          pulls.push(pr);
        }
        if (batch.length < 100) break;
      }

      const { workflow_runs } = await client.listWorkflowRuns(owner, name);
      for (const run of workflow_runs) await projectRun(db, repoRef, run);

      // The onboarding profile step listens for these same runs and PRs by
      // webhook; when a delivery is missed the card is stuck until this walk
      // replays them (before refreshRepoProfile below, which finishes the step
      // once the merged file is on the default branch).
      await repairProfileStep(db, repoRef, pulls, workflow_runs);

      await repairSubIssueLinks(db, repoRef, client);
      await repairDependencies(db, repoRef, client);
      await refreshRepoProfile(db, repoRef, client);
      await importGateAssignments(db, repoRef, client);
      await importTestingPolicy(db, repoRef, client);

      // Artifacts for every epic currently at (or past) a document gate.
      if (cfg.CONSOLE_MASTER_KEY) {
        const epics = await db
          .select({ id: issues.id, number: issues.number, factoryState: issues.factoryState })
          .from(issues)
          .where(and(eq(issues.repoId, repoRow.id), eq(issues.kind, "epic")));
        for (const epic of epics) {
          if (epic.factoryState && epic.factoryState !== "factory:intake") {
            await refreshEpicArtifacts(db, repoRef, client, epic.id, epic.number, cfg.CONSOLE_MASTER_KEY);
          }
        }
      }

      await db.update(repos).set({ lastSyncedAt: new Date() }).where(eq(repos.id, repoRow.id));
      report.reposWalked++;
    } catch (err) {
      report.errors.push(`${repoRow.fullName}: ${(err as Error).message}`);
    }
  }

  await db.update(estates).set({ lastSyncedAt: new Date() }).where(eq(estates.id, estateId));
  return report;
}

export async function reconcileAll(db: Db, cfg: ConsoleConfig, auth: AppAuth, estateIds?: string[]): Promise<ReconcileReport[]> {
  const rows = estateIds?.length
    ? await db.select({ id: estates.id }).from(estates).where(inArray(estates.id, estateIds))
    : await db.select({ id: estates.id }).from(estates);
  const reports: ReconcileReport[] = [];
  for (const row of rows) reports.push(await reconcileEstate(db, cfg, auth, row.id));
  return reports;
}
