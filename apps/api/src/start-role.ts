import { mintForOrchestrator } from "@console/core";
import { estates } from "@console/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./context.js";
import { dispatchFactoryRole, type OrchestratorDispatch } from "./orchestrator-dispatch.js";
import { readRetainedAgentSecrets } from "./orchestrator-secrets.js";

/**
 * The role the factory runs on its own at each epic state that waits on the
 * factory rather than on a person. An epic sitting at one of these with no
 * run live is a hand-off that was missed (an event lost, an engine down, a
 * router that skipped it), and the fix is to start that role by hand.
 */
export const ROLE_FOR_STATE: Record<string, string> = {
  "factory:intake": "intake",
  "factory:spec-approved": "planner",
  "factory:planned": "architect",
  "factory:design-approved": "dispatch",
};

/**
 * Start one factory role on an issue through the orchestrator, the way the
 * profiler is started from onboarding: a fresh installation token so the role
 * can write as the App, plus the retained agent secrets.
 */
export async function startFactoryRole(
  deps: AppDeps,
  args: { orgId: string; estateId: string; owner: string; repo: string; issue: number; role: string },
): Promise<OrchestratorDispatch> {
  const estate = (await deps.dbh.db.select().from(estates).where(eq(estates.id, args.estateId)).limit(1))[0];
  let githubToken: string | undefined;
  let githubTokenExpiresAt: string | undefined;
  try {
    const auth = await deps.credentials.auth();
    if (auth && estate) {
      const minted = await mintForOrchestrator(auth, estate.installationId);
      githubToken = minted.token;
      githubTokenExpiresAt = new Date(minted.expiresAt).toISOString();
    }
  } catch {
    /* the orchestrator can still mint its own token from a real App key */
  }
  const secrets = await readRetainedAgentSecrets(deps, args.orgId);
  return dispatchFactoryRole(deps.cfg, {
    owner: args.owner,
    repo: args.repo,
    role: args.role,
    issue: args.issue,
    githubToken,
    githubTokenExpiresAt,
    installationId: estate?.installationId,
    ...secrets,
  });
}
