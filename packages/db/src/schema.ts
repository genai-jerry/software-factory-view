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
  /** Per-org Ask-the-Factory model; null falls back to INSIGHT_DEEP_MODEL. */
  insightModel: text("insight_model"),
  /** Per-org Anthropic API key (AES-GCM under CONSOLE_MASTER_KEY); null falls back to ANTHROPIC_API_KEY. */
  encryptedInsightApiKey: text("encrypted_insight_api_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ghUserId: bigint("gh_user_id", { mode: "number" }).notNull(),
    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    encryptedOauthToken: text("encrypted_oauth_token"),
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
    profileSha: text("profile_sha"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("repos_node_id").on(t.ghNodeId), index("repos_estate").on(t.estateId)],
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
    payload: jsonb("payload").$type<Record<string, unknown>>(),
  },
  (t) => [index("webhook_deliveries_received").on(t.receivedAt)],
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
