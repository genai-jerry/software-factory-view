import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Two schema areas with different lifecycle guarantees (spec 02):
 *  - PROJECTIONS mirror GitHub, keyed by node_id, guarded by gh_updated_at,
 *    and are rebuildable from the API at any time. Never backed up.
 *  - CONSOLE-NATIVE tables are the product's own state and are backed up.
 * No table mixes the two.
 */

/* ------------------------------- console-native: instance config ------------------------------- */

/**
 * The Console's own GitHub App credentials. Kept here rather than in the
 * environment so an operator can register the App from the setup screen
 * (manifest flow) and never hand-copy a private key. Secrets are encrypted
 * with CONSOLE_MASTER_KEY, which remains the one thing the environment must
 * supply. Singleton: exactly one row, id = 'default'.
 */
export const githubAppConfig = pgTable("github_app_config", {
  id: text("id").primaryKey().default("default"),
  appId: text("app_id").notNull(),
  slug: text("slug"),
  htmlUrl: text("html_url"),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  encryptedWebhookSecret: text("encrypted_webhook_secret").notNull(),
  clientId: text("client_id").notNull(),
  encryptedClientSecret: text("encrypted_client_secret").notNull(),
  configuredBy: text("configured_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------- console-native: identity ------------------------------- */

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("solo"),
  insightBudgetTokens: bigint("insight_budget_tokens", { mode: "number" }).notNull().default(5_000_000),
  insightUsedTokens: bigint("insight_used_tokens", { mode: "number" }).notNull().default(0),
  /** Per-org Ask-the-Factory provider: anthropic | openai | grok | openrouter; null = anthropic. */
  insightProvider: text("insight_provider"),
  /** Per-org Ask-the-Factory model; null falls back to INSIGHT_DEEP_MODEL (anthropic only). */
  insightModel: text("insight_model"),
  /** Per-org Anthropic API key (AES-GCM under CONSOLE_MASTER_KEY); null falls back to ANTHROPIC_API_KEY. */
  encryptedInsightApiKey: text("encrypted_insight_api_key"),
  /**
   * Which motor drives factory roles for this org's repos: `github-actions`
   * (default) or `software-factory` (the LangGraph orchestrator). When
   * software-factory is selected, the Console must not write Actions secrets
   * or rely on workflow stubs.
   */
  orchestrator: text("orchestrator").notNull().default("github-actions"),
  /**
   * Org-wide branch defaults (FACTORY.md §6a). GitHub stays authoritative for
   * a repo's real default branch, and a repo's own policy file / profile for
   * its integration branch; these fill the gaps: `stagingBranch` is the
   * integration-branch name used when a repo carries no policy file, and both
   * template the stub-files PR for newly connected repos. Null = the
   * factory's built-ins (main / staging).
   */
  defaultBranch: text("default_branch"),
  stagingBranch: text("staging_branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Agent credentials retained for the Software Factory orchestrator. Write-only
 * through the API (GET exposes name + updatedAt). Sealed with CONSOLE_MASTER_KEY
 * in the same envelope as other Console secrets so the orchestrator can decrypt
 * them from this table.
 */
export const orchestratorSecrets = pgTable(
  "orchestrator_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("orchestrator_secret_org_name").on(t.orgId, t.name)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ghUserId: bigint("gh_user_id", { mode: "number" }).notNull(),
    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    encryptedOauthToken: text("encrypted_oauth_token"),
    // A GitHub App that expires user authorizations issues 8-hour access
    // tokens alongside a 6-month refresh token, and rotates the refresh token
    // on every use. Both halves and both expiries live here so the API can
    // renew the grant in the background instead of asking the human to sign
    // out and back in twice a day.
    encryptedOauthRefreshToken: text("encrypted_oauth_refresh_token"),
    oauthTokenExpiresAt: timestamp("oauth_token_expires_at", { withTimezone: true }),
    oauthRefreshTokenExpiresAt: timestamp("oauth_refresh_token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_gh_user_id").on(t.ghUserId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // opaque random token
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | admin | member | viewer
  },
  (t) => [uniqueIndex("memberships_org_user").on(t.orgId, t.userId)],
);

export const gateAssignments = pgTable(
  "gate_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id").notNull(),
    repoId: uuid("repo_id"),
    gate: text("gate").notNull(), // spec | design | implementation | release
    login: text("login").notNull(), // GitHub login from factory-approvers.json
    syncedFromSha: text("synced_from_sha"),
  },
  (t) => [uniqueIndex("gate_assignments_unique").on(t.estateId, t.repoId, t.gate, t.login)],
);

/**
 * Console-native grouping: a project collects repos that ship together, so
 * every view can be focused to one project (or one repo) at a time. A repo
 * belongs to at most one project; deleting a project releases its repos.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_org_name").on(t.orgId, t.name)],
);

/* ------------------------------- projections: estate/repo ------------------------------- */

export const estates = pgTable("estates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  coordinationRepoId: uuid("coordination_repo_id"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    estateId: uuid("estate_id").notNull().references(() => estates.id, { onDelete: "cascade" }),
    ghNodeId: text("gh_node_id").notNull(),
    fullName: text("full_name").notNull(), // owner/repo
    defaultBranch: text("default_branch").notNull().default("main"),
    stagingBranch: text("staging_branch"),
    factoryEnabled: boolean("factory_enabled").notNull().default(false),
    /**
     * The repo's system-test policy, mirrored from `.github/factory-testing.json`
     * (FACTORY.md §4b) in the same walk that mirrors the approver file. Null in
     * both columns means the Console has not read the file yet — distinct from
     * `false`, which is the file saying system tests are off. Readers must not
     * collapse the two: "off" hides the test actions, "unread" leaves them to
     * the factory's own answer.
     */
    systemTests: boolean("system_tests"),
    testMode: text("test_mode"), // gate | advisory
    /** Where the cases run: `epic` (a preview per epic) or `staging` (after gate GS). Null is unread. */
    testRunOn: text("test_run_on"),
    /**
     * Bug reports (FACTORY.md §4c), from the same file. Null is "unread", the
     * same as the two above; the parsed value already resolves the follows-
     * `system_tests` default, so a false here is the file saying no.
     */
    bugReports: boolean("bug_reports"),
    profileSha: text("profile_sha"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("repos_node_id").on(t.ghNodeId),
    index("repos_estate").on(t.estateId),
    index("repos_project").on(t.projectId),
  ],
);

/* ------------------------------- projections: pipeline ------------------------------- */

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    repoId: uuid("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    ghNodeId: text("gh_node_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull(), // open | closed
    author: text("author"),
    kind: text("kind").notNull().default("plain"), // epic | task | plain
    parentIssueId: uuid("parent_issue_id"),
    factoryState: text("factory_state"), // current factory:* label or null
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    assignees: jsonb("assignees").$type<string[]>().notNull().default([]),
    milestoneTitle: text("milestone_title"),
    milestoneNumber: integer("milestone_number"),
    htmlUrl: text("html_url").notNull().default(""),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("issues_node_id").on(t.ghNodeId),
    index("issues_repo_number").on(t.repoId, t.number),
    index("issues_org_state").on(t.orgId, t.factoryState),
    index("issues_parent").on(t.parentIssueId),
    index("issues_org_milestone").on(t.orgId, t.milestoneTitle),
  ],
);

/**
 * Blocked-by edges between issues (task ordering, cross-repo merge order).
 * Two sources with a precedence: 'github' rows mirror the native issue-
 * dependency relations and win; 'body' rows are parsed from "blocked by #n"
 * markers in issue bodies and only fill gaps. Repaired delete-then-insert by
 * the reconciler (github) and by projectIssue (body), so the table is fully
 * rebuildable like every projection.
 */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    blockedIssueId: uuid("blocked_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    blockerIssueId: uuid("blocker_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // github | body
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_deps_pair").on(t.blockedIssueId, t.blockerIssueId),
    index("task_deps_blocker").on(t.blockerIssueId),
    index("task_deps_org").on(t.orgId),
  ],
);

export const issueStateHistory = pgTable(
  "issue_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    fromState: text("from_state"),
    toState: text("to_state"),
    actor: text("actor"),
    sourceEventId: text("source_event_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ish_issue").on(t.issueId, t.occurredAt),
    uniqueIndex("ish_dedupe").on(t.issueId, t.sourceEventId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    ghNodeId: text("gh_node_id").notNull(),
    ghId: bigint("gh_id", { mode: "number" }).notNull(),
    author: text("author"),
    body: text("body").notNull(),
    isAgent: boolean("is_agent").notNull().default(false),
    isApproval: boolean("is_approval").notNull().default(false),
    consoleMarkers: jsonb("console_markers").$type<{ thread?: string; decision?: string }>().notNull().default({}),
    htmlUrl: text("html_url").notNull().default(""),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }).notNull(),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("comments_node_id").on(t.ghNodeId), index("comments_issue").on(t.issueId, t.ghCreatedAt)],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    repoId: uuid("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    ghNodeId: text("gh_node_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("other"), // spec | design | task | promotion | other
    issueNumber: integer("issue_number"), // factory issue this PR belongs to (from branch name)
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha"),
    baseRef: text("base_ref").notNull(),
    state: text("state").notNull(),
    draft: boolean("draft").notNull().default(false),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergeCommitSha: text("merge_commit_sha"),
    ciStatus: text("ci_status"), // success | failure | pending | null
    author: text("author"),
    htmlUrl: text("html_url").notNull().default(""),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("prs_node_id").on(t.ghNodeId),
    index("prs_repo_number").on(t.repoId, t.number),
    index("prs_issue").on(t.orgId, t.issueNumber),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    repoId: uuid("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    ghNodeId: text("gh_node_id").notNull(),
    ghRunId: bigint("gh_run_id", { mode: "number" }).notNull(),
    workflowName: text("workflow_name"),
    role: text("role"),
    triggerEvent: text("trigger_event"),
    status: text("status"),
    conclusion: text("conclusion"),
    headBranch: text("head_branch"),
    htmlUrl: text("html_url").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("runs_node_id").on(t.ghNodeId), index("runs_repo").on(t.repoId, t.startedAt)],
);

/* ------------------------------- projections: artifacts ------------------------------- */

export const artifactCache = pgTable(
  "artifact_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    repoId: uuid("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    commitSha: text("commit_sha").notNull(),
    encryptedContent: text("encrypted_content").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("artifact_cache_key").on(t.repoId, t.path, t.commitSha)],
);

export const changes = pgTable(
  "changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    estateId: uuid("estate_id").notNull(),
    epicIssueId: uuid("epic_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"), // active | archived
  },
  (t) => [uniqueIndex("changes_epic").on(t.epicIssueId)],
);

export const changeArtifacts = pgTable(
  "change_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").notNull(),
    kind: text("kind").notNull(), // proposal | spec | design | tasks
    path: text("path").notNull(),
    latestSha: text("latest_sha"), // as proposed (branch tip)
    mergedSha: text("merged_sha"), // as approved (default branch)
  },
  (t) => [uniqueIndex("change_artifacts_key").on(t.changeId, t.repoId, t.path)],
);

/* ------------------------------- console-native: workspace ------------------------------- */

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    epicIssueId: uuid("epic_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    topicKind: text("topic_kind").notNull(), // artifact | gate | task | decision | free | inbox
    topicRef: text("topic_ref").notNull(), // stable string, used in comment markers
    title: text("title").notNull(),
    status: text("status").notNull().default("open"), // open | resolved
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("threads_topic").on(t.epicIssueId, t.topicRef)],
);

export const threadEntries = pgTable(
  "thread_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    threadId: uuid("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // gh_comment | console_note
    commentId: uuid("comment_id"), // references comments.id when source=gh_comment
    body: text("body"), // only for console_note
    author: text("author"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("thread_entries_thread").on(t.threadId, t.createdAt), uniqueIndex("thread_entries_comment").on(t.commentId)],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    epicIssueId: uuid("epic_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id"),
    title: text("title").notNull(),
    context: text("context"),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    chosen: text("chosen"),
    consequences: text("consequences"),
    decidedBy: text("decided_by"),
    ghCommentNodeId: text("gh_comment_node_id"),
    supersedesId: uuid("supersedes_id"),
    status: text("status").notNull().default("decided"), // proposed | decided | superseded
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("decisions_epic").on(t.epicIssueId)],
);

export const qaConversations = pgTable(
  "qa_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    epicIssueId: uuid("epic_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** Set for issue-scoped conversations (peek Q&A); null = the whole epic. */
    scopeIssueId: uuid("scope_issue_id").references(() => issues.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    visibility: text("visibility").notNull().default("private"), // private | shared
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("qa_conversations_epic").on(t.epicIssueId), index("qa_conversations_scope").on(t.scopeIssueId)],
);

export const qaMessages = pgTable(
  "qa_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => qaConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    body: text("body").notNull(),
    citations: jsonb("citations").$type<Array<{ kind: string; ref: string; detail?: string }>>().notNull().default([]),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("qa_messages_conv").on(t.conversationId, t.createdAt)],
);

/* ------------------------------- console-native: operations ------------------------------- */

export const onboardingRuns = pgTable(
  "onboarding_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    estateId: uuid("estate_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    step: text("step").notNull(), // labels | secrets | openspec | profile | stubs | validate | canary
    status: text("status").notNull().default("pending"), // pending | running | ok | failed
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("onboarding_step").on(t.repoId, t.step)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    target: text("target").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_org_at").on(t.orgId, t.at)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryGuid: text("delivery_guid").primaryKey(),
    event: text("event").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** Last processing failure for this delivery; cleared when a retry succeeds. */
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
  },
  (t) => [index("webhook_deliveries_received").on(t.receivedAt)],
);

/**
 * One row per reconcile walk of an estate — the worker's answer to "did the
 * sync actually run, and what did it find?". estate_id is deliberately not a
 * foreign key so the history survives an estate being disconnected.
 */
export const reconcileRuns = pgTable(
  "reconcile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id"),
    trigger: text("trigger").notNull(), // nightly-reconcile | on-demand | initial-sync
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    reposWalked: integer("repos_walked").notNull().default(0),
    issuesSeen: integer("issues_seen").notNull().default(0),
    pullsSeen: integer("pulls_seen").notNull().default(0),
    errors: jsonb("errors").$type<string[]>().notNull().default([]),
  },
  (t) => [index("reconcile_runs_started").on(t.startedAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(), // gate_ready | blocked | awaiting_merge | mention | decision
    title: text("title").notNull(),
    link: text("link").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user").on(t.userId, t.createdAt)],
);

/** Per-user "last looked at this gate" refs, powering the what-changed diff. */
export const gateViews = pgTable(
  "gate_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    epicIssueId: uuid("epic_issue_id").notNull(),
    gate: text("gate").notNull(),
    lastViewedSha: text("last_viewed_sha"),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gate_views_key").on(t.userId, t.epicIssueId, t.gate)],
);

/**
 * Unhandled route errors, kept so an operator can read them after the
 * container that logged them has been replaced by a deploy. Container logs
 * are gone with the container; this is not. Read by `/api/ops/errors`.
 */
export const apiErrors = pgTable(
  "api_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    name: text("name"),
    message: text("message").notNull(),
    stack: text("stack"),
    actor: text("actor"),
  },
  (t) => [index("api_errors_at").on(t.at)],
);

/**
 * Shape: a person's conversation that turns an idea into work. Private to
 * its author, scoped to the repository the chat may read; the spec is the
 * requirement written from it, and the issue is where it went.
 */
export const shapeConversations = pgTable(
  "shape_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    /** The home repository: the session's working directory, and where the issue opens. Null for a new product (scope `new`) until it is opened as work. */
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    /** `shape`: shaping an idea. `investigate`: finding out what went wrong in production (logs + code), then planning the fix. */
    kind: text("kind").$type<"shape" | "investigate">().notNull().default("shape"),
    /** `repo`: about one repository. `project`: spans every factory-enabled repository of the home repo's project. `new`: a new product with no repository; Claude reads no code. */
    scope: text("scope").notNull().default("repo"),
    title: text("title").notNull(),
    spec: text("spec"),
    specUpdatedAt: timestamp("spec_updated_at", { withTimezone: true }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    issueUrl: text("issue_url"),
    /** Set when the conversation is about an epic: the session runs on its branch with its documents in context. */
    epicIssueId: uuid("epic_issue_id").references(() => issues.id, { onDelete: "set null" }),
    /** The orchestrator's Claude session for this conversation, resumed on the next message so the model keeps what it read. */
    askSession: text("ask_session"),
    askSessionAt: timestamp("ask_session_at", { withTimezone: true }),
    /** The requirement is written in the background: idle | pending | done | failed. */
    specStatus: text("spec_status").notNull().default("idle"),
    specError: text("spec_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shape_conversations_user").on(t.userId, t.updatedAt), index("shape_conversations_epic").on(t.epicIssueId)],
);

export const shapeMessages = pgTable(
  "shape_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => shapeConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<Array<{ id: string; name: string; mime: string }>>().notNull().default([]),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    model: text("model"),
    /** An assistant message is answered in the background: pending | done | failed. */
    status: text("status").notNull().default("done"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shape_messages_conv").on(t.conversationId, t.createdAt)],
);

export const shapeAttachments = pgTable("shape_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  conversationId: uuid("conversation_id").notNull().references(() => shapeConversations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  bytesB64: text("bytes_b64").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Images attached to a work item as it is filed from Add work. GitHub's API
 * takes no uploads, so the issue links to these; a Compass sign-in in the
 * org opens them. `issueUrl` is set once the issue exists.
 */
export const workAttachments = pgTable(
  "work_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    repoId: uuid("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    bytesB64: text("bytes_b64").notNull(),
    size: integer("size").notNull(),
    issueUrl: text("issue_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("work_attachments_user_created").on(t.userId, t.createdAt), index("work_attachments_repo_issue").on(t.repoId, t.issueUrl)],
);

/* ------------------------------ Telegram decisions (console-native) ------------------------------ */

/** One Telegram private chat linked to one Compass user (openspec telegram-decisions). */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    tgUsername: text("tg_username"),
    paused: boolean("paused").notNull().default(false),
    /** Set once the first sweep after linking has sent its capped backlog. */
    primed: boolean("primed").notNull().default(false),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("telegram_links_chat").on(t.chatId)],
);

/** A decision sent to a person; open until it leaves their Decisions list. */
export const telegramNotifications = pgTable(
  "telegram_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    epicId: text("epic_id").notNull(),
    repo: text("repo").notNull(),
    ask: text("ask").notNull(),
    /** What the message was built from: the work item at send time. */
    item: jsonb("item").$type<Record<string, unknown>>().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("telegram_notifications_user_open").on(t.userId, t.resolvedAt), index("telegram_notifications_chat_msg").on(t.chatId, t.messageId)],
);

/** A discussion about one decision with the read-only Claude session. */
export const telegramConversations = pgTable(
  "telegram_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id").references(() => telegramNotifications.id, { onDelete: "set null" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    /** The issue the discussion — and the comment it ends in — is about. */
    issueId: text("issue_id").notNull(),
    epicId: text("epic_id").notNull(),
    session: text("session"),
    messages: jsonb("messages").$type<Array<{ role: "user" | "assistant"; text: string; at: string }>>().notNull().default([]),
    /** open · drafted (a comment awaits Post it) · posted · cancelled · expired */
    status: text("status").notNull().default("open"),
    draft: text("draft"),
    summary: text("summary"),
    summaryCommentId: bigint("summary_comment_id", { mode: "number" }),
    /** Telegram message ids that belong to this conversation, for reply routing. */
    messageIds: jsonb("message_ids").$type<number[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("telegram_conversations_user").on(t.userId, t.status, t.updatedAt)],
);

/** Telegram update ids already handled (webhook retries are deduplicated). */
export const telegramUpdates = pgTable("telegram_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Start-link nonces already used: a link token links once. Pruned after a day. */
export const telegramLinkNonces = pgTable("telegram_link_nonces", {
  nonce: text("nonce").primaryKey(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One tool a server offers, as Compass last listed it, and whether sessions may use it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  allowed: boolean;
}

/**
 * Compass → Tools: a remote MCP server an org gives its Claude sessions
 * (Shape, Ask, builds). The orchestrator reads this table directly, like
 * orchestrator_secrets; headers are sealed with CONSOLE_MASTER_KEY.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Short id Claude sees in `mcp__<name>__<tool>`: [a-z][a-z0-9_]*. */
    name: text("name").notNull(),
    label: text("label").notNull(),
    transport: text("transport").$type<"http" | "sse">().notNull().default("http"),
    url: text("url").notNull(),
    /** Sealed JSON object of request headers (API keys); never sent to the browser. */
    encryptedHeaders: text("encrypted_headers"),
    headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
    tools: jsonb("tools").$type<McpTool[]>().notNull().default([]),
    useShape: boolean("use_shape").notNull().default(true),
    useAsk: boolean("use_ask").notNull().default(true),
    useBuild: boolean("use_build").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkError: text("check_error"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mcp_servers_org_name").on(t.orgId, t.name)],
);
