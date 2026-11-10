import { mcpPayloadForRepo } from "../mcp-servers.js";
import { InstallationClient } from "@console/core";
import { comments, estates, issues, repos, telegramConversations } from "@console/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../context.js";
import { loadBlockedMeta } from "../attention.js";
import { askOrchestrator } from "../orchestrator-dispatch.js";
import { readRetainedAgentSecrets } from "../orchestrator-secrets.js";

/**
 * Discussing a decision with Compass's read-only Claude session, and the
 * summary of that discussion that goes on the issue before the decision
 * (openspec telegram-decisions, design §6 and §6a).
 */

export type Conversation = typeof telegramConversations.$inferSelect;
type Msg = Conversation["messages"][number];

export const PROPOSED = "PROPOSED COMMENT:";

export function discussInstructions(login: string, decision: string): string {
  return [
    `You are helping @${login} decide on a Software Factory item from their phone, in Telegram.`,
    `The decision waiting on them: ${decision}`,
    "Answer briefly and plainly (a phone screen; no tables). Use the issue, its thread and the repository; say when you do not know.",
    "You cannot post anything, and nothing is posted until they confirm.",
    "Gate approvals are the single word `Approved`. Anything else on a gate is posted as a request for changes. A blocked question is answered with an ordinary comment the builder will read.",
    `When — and only when — they have said what they decided, end your reply with a line \`${PROPOSED}\` followed by exactly the comment to post, written as them, and nothing after it.`,
    "If they ask you to change a drafted comment, reply with the corrected one the same way.",
  ].join("\n");
}

export const SUMMARY_INSTRUCTIONS = [
  "Summarise the discussion above for the issue's permanent record on GitHub.",
  "Cover: the questions raised, the answers and facts given, options considered, and what was decided and why — or, if nothing was decided, say `No decision yet` and what is still open.",
  "Only what was actually said in this discussion. Do not add anything. Markdown bullet points, under 250 words, no heading, no proposed comment.",
].join("\n");

/** Split an answer into what to show and the comment it proposes, if any. */
export function splitProposal(answer: string): { text: string; proposed: string | null } {
  const at = answer.lastIndexOf(PROPOSED);
  if (at < 0) return { text: answer.trim(), proposed: null };
  const proposed = answer.slice(at + PROPOSED.length).trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
  return { text: answer.slice(0, at).trim(), proposed: proposed || null };
}

/** A gate approval exactly as the factory reads one. */
export function isApproval(comment: string): boolean {
  return /^\s*approved\s*[.!]?\s*$/i.test(comment);
}

interface IssueHome {
  issue: typeof issues.$inferSelect;
  fullName: string;
  owner: string;
  name: string;
  installationId: number;
  epicNumber: number | null;
}

export async function issueHome(deps: AppDeps, issueId: string): Promise<IssueHome | null> {
  const db = deps.dbh.db;
  const issue = (await db.select().from(issues).where(eq(issues.id, issueId)).limit(1))[0];
  if (!issue) return null;
  const repo = (await db.select().from(repos).where(eq(repos.id, issue.repoId)).limit(1))[0];
  if (!repo) return null;
  const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
  if (!estate) return null;
  const [owner, name] = repo.fullName.split("/") as [string, string];
  let epicNumber: number | null = issue.kind === "epic" ? issue.number : null;
  if (epicNumber === null && issue.parentIssueId) {
    epicNumber = (await db.select({ n: issues.number }).from(issues).where(eq(issues.id, issue.parentIssueId)).limit(1))[0]?.n ?? null;
  }
  return { issue, fullName: repo.fullName, owner, name, installationId: estate.installationId, epicNumber };
}

async function contextFor(deps: AppDeps, home: IssueHome): Promise<string> {
  const db = deps.dbh.db;
  const asked = (await loadBlockedMeta(deps, [home.issue.id])).get(home.issue.id);
  const questions = asked?.questions?.length ? asked.questions : asked?.question ? [asked.question] : [];
  const talk = await db.select().from(comments).where(eq(comments.issueId, home.issue.id)).orderBy(comments.ghCreatedAt);
  return [
    `Issue: ${home.issue.title} (${home.fullName})`,
    home.issue.body?.trim() ?? "",
    questions.length ? `The factory's open question${questions.length > 1 ? "s" : ""}:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "",
    ...talk.slice(-20).map((c) => `${c.isAgent ? "[agent]" : `@${c.author ?? "?"}`} ${c.body.trim()}`),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(-24_000);
}

function transcript(messages: Msg[]): string {
  return messages.map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${m.text}`).join("\n\n");
}

export type TurnResult = { ok: true; answer: string; session?: string } | { ok: false; error: string };

/**
 * One Claude turn on the conversation, resuming its session when there is one.
 *
 * `fresh` starts a new session instead. A resumed session is sent the question
 * alone — the orchestrator drops new instructions — so a turn that needs its
 * own instructions (the summary) must not resume the discussion's session, or
 * Claude keeps following the discussion's rules and answers with a proposed
 * comment only. The transcript goes in `context`, so nothing is lost.
 */
export async function ask(deps: AppDeps, conv: Conversation, question: string, instructions: string, opts: { fresh?: boolean } = {}): Promise<TurnResult> {
  const home = await issueHome(deps, conv.issueId);
  if (!home) return { ok: false, error: "the issue is no longer in Compass" };
  const secrets = await readRetainedAgentSecrets(deps, home.issue.orgId);
  const context = `${await contextFor(deps, home)}\n\n---\n\nThe discussion so far:\n${transcript(conv.messages)}`.slice(-30_000);
  const got = await askOrchestrator(deps.cfg, {
    owner: home.owner,
    repo: home.name,
    question,
    context,
    instructions,
    mode: "ask",
    conversation: `tg-${conv.id}`,
    ...(conv.session && !opts.fresh ? { session: conv.session } : {}),
    ...(home.epicNumber ? { branch: `factory/epic-${home.epicNumber}` } : {}),
    anthropicApiKey: secrets.anthropicApiKey,
    claudeCodeOauthToken: secrets.claudeCodeOauthToken,
    mcpServers: await mcpPayloadForRepo(deps, home.issue.orgId, home.issue.repoId),
  });
  if ("error" in got) return { ok: false, error: got.error };
  return { ok: true, answer: got.answer, ...(got.session ? { session: got.session } : {}) };
}

/** True once the person has asked something and been answered. */
export function hasExchange(conv: Conversation): boolean {
  return conv.messages.some((m) => m.role === "user") && conv.messages.some((m) => m.role === "assistant");
}

export function recordBody(login: string, summary: string, decided: boolean, when = new Date()): string {
  const date = when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return [
    `**Discussion on Telegram with @${login}** · ${date}`,
    "",
    summary.trim(),
    "",
    decided
      ? `<sub>Recorded by Compass from the discussion. The decision follows as @${login}'s own comment.</sub>`
      : `<sub>Recorded by Compass from the discussion. No decision was posted.</sub>`,
  ].join("\n");
}

/** Post the summary as the Compass GitHub App — a record the factory never reads as a decision. */
export async function postRecord(deps: AppDeps, issueId: string, body: string): Promise<{ id: number; url: string }> {
  const home = await issueHome(deps, issueId);
  if (!home) throw new Error("the issue is no longer in Compass");
  const auth = await deps.credentials.auth();
  if (!auth) throw new Error("the Compass GitHub App is not configured");
  const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, home.installationId);
  const c = await client.createRecordComment(home.owner, home.name, home.issue.number, body);
  return { id: c.id, url: c.html_url };
}
