import { GitHubHttpError, type GhComment } from "@console/core";
import type { FastifyReply } from "fastify";
import { userClient, type AppDeps, type RequestCtx } from "./context.js";

/** The human-readable half of a GitHub error body. */
export function githubMessage(err: GitHubHttpError): string {
  try {
    const parsed = JSON.parse(err.body) as { message?: string };
    if (parsed?.message) return parsed.message;
  } catch {
    // not JSON — fall through to the raw body
  }
  return err.body.slice(0, 200) || `HTTP ${err.status}`;
}

/**
 * Post a comment on an issue as the acting user, turning a GitHub refusal —
 * or a missing/expired OAuth token — into GitHub's own answer with a status
 * the SPA can render, instead of the anonymous 500 an uncaught throw produces.
 *
 * Returns `null` once the reply has been sent, so callers read:
 *
 *     const comment = await postComment(...);
 *     if (!comment) return;
 */
export async function postComment(
  deps: AppDeps,
  ctx: RequestCtx,
  reply: FastifyReply,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GhComment | null> {
  const target = `${owner}/${repo}#${issueNumber}`;
  let gh;
  try {
    gh = userClient(deps, ctx);
  } catch (err) {
    void reply.code(401).send({ error: `${(err as Error).message}` });
    return null;
  }
  try {
    return await gh.createComment(owner, repo, issueNumber, body);
  } catch (err) {
    if (err instanceof GitHubHttpError) {
      const detail = githubMessage(err);
      if (err.status === 401) {
        void reply.code(401).send({ error: `GitHub rejected your sign-in (${detail}) — sign out and back in` });
      } else if (err.status === 403 || err.status === 404) {
        void reply.code(403).send({
          error: `GitHub declined to comment on ${target}: ${detail}. Posting needs write access to the repository and the Console's GitHub App granted Issues: write.`,
        });
      } else {
        void reply.code(502).send({ error: `GitHub declined to comment on ${target}: ${detail}` });
      }
      return null;
    }
    void reply.code(502).send({ error: `could not reach GitHub to comment on ${target}: ${(err as Error).message}` });
    return null;
  }
}

/**
 * Add or remove one label as the acting user, with the same refusal handling
 * as `postComment` — a label write carries authority (the factory reads
 * `factory:expedite` as an instruction and checks who applied it), so it goes
 * out on the user's own token, never the App's.
 *
 * Returns `false` once the reply has been sent, so callers read:
 *
 *     if (!(await writeLabel(...))) return;
 */
export async function writeLabel(
  deps: AppDeps,
  ctx: RequestCtx,
  reply: FastifyReply,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
  action: "add" | "remove",
): Promise<boolean> {
  const target = `${owner}/${repo}#${issueNumber}`;
  let gh;
  try {
    gh = userClient(deps, ctx);
  } catch (err) {
    void reply.code(401).send({ error: `${(err as Error).message}` });
    return false;
  }
  try {
    if (action === "add") await gh.addLabels(owner, repo, issueNumber, [label]);
    else await gh.removeLabel(owner, repo, issueNumber, label);
    return true;
  } catch (err) {
    if (err instanceof GitHubHttpError) {
      const detail = githubMessage(err);
      if (err.status === 401) {
        void reply.code(401).send({ error: `GitHub rejected your sign-in (${detail}) — sign out and back in` });
      } else if (err.status === 403 || err.status === 404) {
        void reply.code(403).send({
          error: `GitHub declined to ${action} \`${label}\` on ${target}: ${detail}. Labelling needs write access to the repository, and the label has to exist — run the Labels step in Onboarding if it does not.`,
        });
      } else {
        void reply.code(502).send({ error: `GitHub declined to ${action} \`${label}\` on ${target}: ${detail}` });
      }
      return false;
    }
    void reply.code(502).send({ error: `could not reach GitHub to ${action} \`${label}\` on ${target}: ${(err as Error).message}` });
    return false;
  }
}
