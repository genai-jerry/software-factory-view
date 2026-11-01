/** DTO shapes mirroring the API responses. */

export interface SetupStatus {
  configured: boolean;
  source: "database" | "environment" | null;
  appSlug: string | null;
  /** The registered App's numeric id, shown so an operator can confirm which App is in use. */
  appId: string | null;
  /** The OAuth client id — public by construction, so the edit form can prefill it. */
  clientId: string | null;
  /** Whether a webhook secret is stored (the secret itself never leaves the API). */
  hasWebhookSecret: boolean;
  /** Whether this caller may register or edit the GitHub App (first-run bootstrap, or the signed-in App owner). */
  canEditApp: boolean;
  hasMasterKey: boolean;
  /** Set when a stored registration exists but cannot be decrypted. */
  credentialError: string | null;
  publicOrigin: string;
  insightEnabled: boolean;
  devLogin: boolean;
  /** When true, the home page can wipe the stored GitHub App registration (APP_RESET=true). */
  appReset: boolean;
}

export interface InstallationSummary {
  installationId: number | null;
  accountId: number | null;
  account: string;
  accountType: string;
  avatarUrl: string | null;
  estateId: string | null;
  estateName: string | null;
  /** GitHub App install/configure URL for this account, when the slug is known. */
  installUrl: string | null;
  /** Existing installation settings — add/remove repos or fix permissions. */
  configureUrl: string | null;
  repos: Array<{
    id: number | null;
    nodeId: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
    connected: boolean;
    /** False when the repo is visible to you but not yet granted to the GitHub App. */
    inInstallation: boolean;
  }>;
}

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  orgs: Array<{ id: string; name: string; role: string }>;
}

/** The owner-only ingestion log (/api/ops/ingestion): the server-side pipeline, on the web. */
export interface IngestionLog {
  summary: {
    lastReceivedAt: string | null;
    lastProcessedAt: string | null;
    /** Deliveries not yet projected. */
    pending: number;
    /** Pending deliveries whose last processing attempt errored. */
    failing: number;
    total: number;
  };
  deliveries: Array<{
    deliveryGuid: string;
    event: string;
    action: string | null;
    repo: string | null;
    receivedAt: string;
    processedAt: string | null;
    error: string | null;
  }>;
  reconciles: Array<{
    id: string;
    estateName: string | null;
    trigger: string;
    startedAt: string;
    finishedAt: string | null;
    reposWalked: number;
    issuesSeen: number;
    pullsSeen: number;
    errors: string[];
  }>;
}

/** Webhook pipeline health, returned alongside /api/estates. */
export interface IngestionHealth {
  /** Newest webhook delivery received — null means GitHub has never reached this Console. */
  lastReceivedAt: string | null;
  /** Newest delivery the worker finished projecting. */
  lastProcessedAt: string | null;
  /** Deliveries recorded but not yet processed (a growing number means the worker or Redis is down). */
  pending: number;
}

export interface EstateSummary {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  stale: boolean;
  repos: Array<{
    id: string;
    fullName: string;
    defaultBranch: string;
    stagingBranch: string | null;
    factoryEnabled: boolean;
    lastSyncedAt: string | null;
  }>;
}

export interface AttentionEntry {
  kind: "gate" | "blocked" | "task-start" | "merge";
  /** 1 = agent halted on you · 2 = gate awaits you · 3 = task start awaits you · 4 = unowned broadcast */
  rank: 1 | 2 | 3 | 4;
  whyYou: string;
  epicId: string;
  issueId: string;
  title: string;
  repo: string;
  state: string | null;
  ageDays: number;
  /** For blocked entries: the agent's actual stuck question, when it left one. */
  question: string | null;
  /** The row's epic carries `factory:expedite` — what it still surfaces for is narrower. */
  expedited: boolean;
  link: string;
}

export type Phase = "specifying" | "planning" | "building" | "shipping" | "held";

export interface DepNode {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
}

export interface MineRow {
  issueId: string;
  epicId: string;
  number: number;
  title: string;
  repo: string;
  kind: string;
  state: string | null;
  phase: Phase;
  whyMine: "assigned" | "author";
  freshness: { lastMovedAt: string; quietDays: number };
  blocked: boolean;
  rollup?: TaskRollup;
}

export interface WaitingRow {
  issueId: string;
  number: number;
  title: string;
  repo: string;
  epicId: string;
  blocker: {
    issueId: string;
    number: number;
    title: string;
    state: string | null;
    phase: Phase;
    htmlUrl: string;
    assignees: string[];
    ageDays: number | null;
  };
}

export interface MyWork {
  needsYou: AttentionEntry[];
  mine: MineRow[];
  waitingOn: WaitingRow[];
}

export interface FlowData {
  estates: Array<{ id: string; name: string; milestones: FlowMilestone[] }>;
}

export interface FlowMilestone {
  title: string;
  trackerState: string | null;
  epics: FlowEpic[];
}

export interface FlowEpic {
  epicId: string;
  number: number;
  title: string;
  repo: string;
  state: string | null;
  phase: Phase;
  daysInState: number;
  rollup: TaskRollup;
  blockedCount: number;
  gate: { gate: string; label: string; approvers: string[] } | null;
  /** The epic carries `factory:expedite`. */
  expedited: boolean;
  /** Open PRs tied to this epic by the factory's branch naming — for a fast-track epic, the PR awaiting merge. */
  prs: EpicPr[];
  tasks: Array<{
    issueId: string;
    number: number;
    title: string;
    state: string | null;
    phase: Phase;
    open: boolean;
    assignees: string[];
    ageDays: number;
    blockedBy: number[];
  }>;
}

export interface EpicPr {
  number: number;
  title: string;
  kind: string;
  draft: boolean;
  ciStatus: string | null;
  htmlUrl: string;
}

export interface IssuePeekData {
  issue: {
    id: string;
    number: number;
    title: string;
    repo: string;
    kind: string;
    state: string | null;
    phase: Phase;
    open: boolean;
    htmlUrl: string;
    assignees: string[];
    author: string | null;
  };
  sentence: string;
  nextMover: string | null;
  gate: { gate: string; label: string; approvers: string[] } | null;
  deps: { blockedBy: DepNode[]; blocks: DepNode[] };
  lastEvent: { at: string; detail: string; actor: string | null } | null;
  blocked: { since: string | null; question: string | null } | null;
  /** Open PRs tied to this issue by the factory's branch naming (fast-track: the PR awaiting merge). */
  prs: EpicPr[];
  epicId: string;
}

export interface BoardCard {
  epicId: string;
  number: number;
  title: string;
  repo: string;
  estateId: string;
  state: string | null;
  open: boolean;
  daysInState: number;
  blocked: boolean;
  /** The epic carries `factory:expedite`. */
  expedited: boolean;
  tasks: TaskRollup;
}

/** An epic's system test cases (FACTORY.md §4b), counted apart from its code
 * tasks. Absent where the repo runs no system tests, or the epic has none. */
export interface TestRollup {
  total: number;
  passed: number;
  runnable: number;
  failed: number;
  skipped?: number;
  outstanding: number;
}

export interface TaskRollup {
  total: number;
  ready: number;
  inReview: number;
  inTest: number;
  /** Green and merged onto the epic/integration branch, not yet closed. */
  shipping: number;
  /** Of `shipping`: green and waiting for the Release Manager. */
  readyToShip?: number;
  /** Of `shipping`: merged onto the epic branch. */
  onEpic?: number;
  done: number;
  blocked: number;
  /** Open tasks that have at least one open blocker. */
  waiting: number;
  /** In review, in test or on a branch — the work the done count cannot see. */
  inFlight: number;
  tests?: TestRollup;
  bugs?: BugRollup;
}

/** An epic's bug reports (FACTORY.md §4c), counted apart from its code tasks. */
export interface BugRollup {
  total: number;
  /** Raised; the task fixing it is in flight. */
  fixing: number;
  /** The fix is assembled; a tester has to confirm it. */
  retest: number;
  verified: number;
  /** `fixing + retest` — what the epic still waits on. */
  open: number;
}

export interface EpicWorkspace {
  epic: {
    id: string;
    number: number;
    title: string;
    bodyHtml: string;
    state: string | null;
    open: boolean;
    author: string | null;
    htmlUrl: string;
    labels: string[];
    /** Derived progress where the label cannot carry it; null means use the label. */
    status: string | null;
    /** The stage the epic's work is actually in (the label stays at design-approved for the whole build); null: use `state`. */
    stage?: string | null;
    nextStep: NextStep;
  };
  repo: { id: string; fullName: string; defaultBranch: string };
  pipeline: string[];
  gate: { gate: string; label: string; amApprover: boolean; approvers: string[] } | null;
  /**
   * The expedite marker and its toggle: on/off from the label, whether it may
   * be flipped here and why not, and the Console's record of the last flip —
   * `lastFlip.on` while `on` is false is the factory having reverted it.
   */
  expedite: {
    on: boolean;
    available: boolean;
    dormant: boolean;
    reason: string | null;
    lastFlip: { on: boolean; actor: string | null; at: string } | null;
  };
  /** The task start gate — who may Approve a `factory:ready` task into build. */
  startGate: { approvers: string[]; amApprover: boolean };
  tasks: Array<{
    id: string;
    number: number;
    title: string;
    kind: string;
    caseId: string | null;
    state: string | null;
    open: boolean;
    htmlUrl: string;
    blockedBy: DepNode[];
    blocks: DepNode[];
    /** Where this task stands at the start gate — see `startStatusLabel`. */
    nextStep: NextStep;
    startStatus: TaskStartStatus;
    /** A factory run is live on this task now, and which role it is. */
    running?: boolean;
    runningRole?: string | null;
    /** The live orchestrator run on this task, and the repo the task is in. */
    runId?: string | null;
    repo?: string;
    /** The start gate is open AND still takes an approval: draw the button. */
    approvable: boolean;
  }>;
  rollup: TaskRollup;
  blockedSubIssues: Array<{ id: string; number: number; title: string; htmlUrl: string }>;
  change: { id: string; slug: string; status: string } | null;
  artifacts: Array<{ id: string; kind: string; path: string; latestSha: string | null; mergedSha: string | null; diverged: boolean }>;
  threads: Array<{ id: string; topicKind: string; topicRef: string; title: string; status: string; entryCount: number }>;
  /**
   * The epic's system-test standing (FACTORY.md §4b) — what the Tests tab
   * renders when there are no cases to render.
   *
   * `enabled` is the repo's mirrored `.github/factory-testing.json`: null
   * means the Console has not read the file, which is not the same as tests
   * being off and must not render as it.
   */
  /**
   * The epic's bug reports (FACTORY.md §4c) and whether another may be
   * raised here — the Tests tab's second half. `enabled: null` is an unread
   * policy, not bugs being off.
   */
  bugs: {
    enabled: boolean | null;
    rows: Array<{
      id: string;
      number: number;
      title: string;
      state: string | null;
      open: boolean;
      htmlUrl: string;
      /** The task(s) filed to fix it. */
      fixes: DepNode[];
      nextStep: NextStep;
    }>;
    report: { offered: boolean; reason: string | null };
  };
  systemTests: {
    enabled: boolean | null;
    mode: "gate" | "advisory" | null;
    /** A plan exists: the document, the cases, or both. */
    planned: boolean;
    /** The plan document. `merged: false` is why cases are not runnable yet. */
    plan: { path: string; merged: boolean } | null;
    /** Whether to offer Plan tests, and — when not — why not. */
    planTests: { offered: boolean; reason: string | null };
  };
  freshness: { lastSyncedAt: string | null; stale: boolean };
  orchestrator: {
    engine: "github-actions" | "software-factory";
    githubActionsEnabled: boolean;
    canStart: boolean;
  };
}

export interface TimelineEvent {
  type: "state" | "run";
  at: string;
  detail: string;
  actor: string | null;
  link?: string;
}

export interface ArtifactView {
  path: string;
  ref: string;
  sha: string;
  markdown: string;
  html: string;
  otherSha: string | null;
}

export interface ThreadDetail {
  id: string;
  title: string;
  topicKind: string;
  topicRef: string;
  status: string;
  entries: Array<{
    id: string;
    source: string;
    author: string | null;
    bodyHtml: string;
    isAgent: boolean;
    isApproval: boolean;
    htmlUrl: string | null;
    createdAt: string;
  }>;
}

export interface GatePanelData {
  gate: string;
  label: string;
  state: string | null;
  amApprover: boolean;
  approvers: string[];
  /** The gate whose list is standing in, when this gate's own is unset (GS → release). */
  approversFrom: string | null;
  commentApprovable: boolean;
  /** Gate GS only: what the factory assembled, which is what GS decides on. */
  assembly: {
    cases: Array<{
      number: number;
      title: string;
      state: string | null;
      open: boolean;
      htmlUrl: string;
      caseId: string | null;
      verdict: "passed" | "failed" | "runnable" | "pending" | "skipped";
      verdictBy: string | null;
      verdictAt: string | null;
    }>;
    testsOutstanding: number;
    /** Bug reports raised against this epic (FACTORY.md §4c). */
    bugs: Array<{ number: number; title: string; state: string | null; open: boolean; htmlUrl: string }>;
    bugsOpen: number;
    tasks: Array<{ number: number; title: string; state: string | null; open: boolean; htmlUrl: string }>;
    allGreen: boolean;
    report: { author: string | null; at: string; html: string; htmlUrl: string | null } | null;
    prs: PrSummary[];
  } | null;
  documentPrs: PrSummary[];
  releasePrs: PrSummary[];
  artifacts: Array<{ path: string; kind: string; sha: string | null; mergedSha: string | null; html: string | null }>;
  currentSha: string | null;
  changedSinceLastView: boolean;
  lastViewedSha: string | null;
  openQuestions: Array<{ id: string; title: string; topicRef: string; entryCount: number }>;
}

export interface PrSummary {
  id: string;
  number: number;
  title: string;
  kind: string;
  state: string;
  draft: boolean;
  ciStatus: string | null;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
}

export interface Decision {
  id: string;
  title: string;
  context: string | null;
  options: string[];
  chosen: string | null;
  consequences: string | null;
  decidedBy: string | null;
  status: string;
  supersedesId: string | null;
  createdAt: string;
}

export interface BlockedIssue {
  id: string;
  number: number;
  title: string;
  repo: string;
  epicId: string;
  htmlUrl: string;
  ageDays: number;
}

export interface QaData {
  conversations: Array<{
    id: string;
    visibility: string;
    messages: Array<{ role: string; body: string; citations: Citation[]; createdAt: string }>;
  }>;
  enabled: boolean;
  /** "claude": the orchestrator's Claude CLI on the factory's subscription token (tried first); "api": the org's API key. */
  via?: "claude" | "api";
  /** The provider/model this org's questions run on (org override or instance default). */
  provider?: string;
  model?: string;
  budget: { used: number; total: number } | null;
}

export interface TreeDep {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
  repo: string;
  inTree: boolean;
}

/**
 * The start gate has three moments and one of them wants a button — the API
 * derives this from the run marker and the approval comment, because the
 * `factory:ready` label alone covers all three (see core/start-gate.ts).
 */
export type TaskStartStatus = "none" | "awaiting" | "approved" | "running" | "stalled" | "auto";

/**
 * What is expected of the next actor — the same answer the factory posts on
 * the issue when a run ends, shown beside the state it belongs to. A state is
 * not an instruction: "In review" means "start the Reviewer", and until this
 * was on screen nothing said so.
 */
export interface NextStep {
  who: string;
  how: string;
  /** The role a person has to start here, when that is the move. */
  startRole: "architect" | "reviewer" | "qa" | "release" | "ops" | null;
  startLabel: string | null;
  waitsOnPerson: boolean;
  /**
   * The factory takes this hop itself (expedite). `startRole` may still be
   * set — a human may take any stage over — so the Console shows the automatic
   * cue and keeps the manual start behind an explicit affordance.
   */
  automatic: boolean;
}

export interface TreeNode {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
  repo: string;
  crossRepo: boolean;
  assignees: string[];
  blockedBy: TreeDep[];
  blocks: TreeDep[];
  waiting: boolean;
  agentHalted: boolean;
  nextStep: NextStep;
  startStatus: TaskStartStatus;
  approvable: boolean;
}

export interface EpicTree {
  epic: {
    id: string;
    number: number;
    title: string;
    state: string | null;
    open: boolean;
    htmlUrl: string;
    repo: string;
    gate: { gate: string; label: string } | null;
    rollup: TaskRollup;
    /** Derived progress where the label cannot carry it; null means use the label. */
    status: string | null;
    nextStep: NextStep;
    /** The epic carries `factory:expedite`; every node below inherits it. */
    expedited: boolean;
  };
  startGate: { approvers: string[]; amApprover: boolean };
  nodes: TreeNode[];
}

export interface OrgSettings {
  id: string;
  name: string;
  role: string;
  orchestrator: {
    engine: "github-actions" | "software-factory";
    githubActionsEnabled: boolean;
  };
  insight: {
    provider: string;
    model: string | null;
    hasKey: boolean;
    defaultModel: string;
    globalKeyConfigured: boolean;
    providers: string[];
  };
  branches: {
    defaultBranch: string | null;
    stagingBranch: string | null;
  };
  allowedSecrets: string[];
  retainedSecrets: Array<{ name: string; updatedAt: string; updatedBy: string | null }>;
}

export interface ProjectsData {
  projects: Array<{ id: string; orgId: string; name: string; repos: Array<{ id: string; fullName: string }> }>;
  unassigned: Array<{ id: string; orgId: string; fullName: string }>;
}

export interface SecretWriteResult {
  name: string;
  stored?: boolean;
  githubActions?: boolean;
  results: Array<{ repo: string; ok: boolean; error?: string }>;
}

export interface Citation {
  kind: string;
  ref: string;
  detail?: string;
}

export interface OnboardingState {
  estateId: string;
  orchestrator: {
    engine: "github-actions" | "software-factory";
    githubActionsEnabled: boolean;
  };
  repos: Array<{
    repoId: string;
    fullName: string;
    factoryEnabled: boolean;
    steps: Record<string, { status: string; detail: Record<string, unknown>; updatedAt: string }>;
  }>;
}

export interface ValidationResult {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean | null; detail: string }>;
}

/** GET /api/running — one open task or epic with a factory run live on it. */
export interface RunningItem {
  issueId: string;
  number: number;
  title: string;
  repo: string;
  kind: "task" | "epic";
  role: string;
  /** The live orchestrator run: its log is what the card opens. Null when the orchestrator cannot say. */
  runId?: string | null;
  epicId: string;
  epicNumber: number;
  epicTitle: string;
}

/** One finished factory run, from GET /api/runs/recent. */
export interface PastRunItem {
  runId: string;
  repo: string;
  number: number;
  /** The task or epic the run was on, when the Console knows it. */
  title: string | null;
  kind: string | null;
  epicId: string | null;
  epicNumber: number | null;
  role: string;
  /** success | error | timeout | no_op */
  outcome: string;
  startedAt: string;
  finishedAt: string;
  seconds: number;
  model: string | null;
  error: string | null;
  /** The run's log can still be opened. */
  hasLog: boolean;
}

/** GET /api/orchestrator/usage — the orchestrator's GET /usage. */
export interface FactoryUsage {
  as_of: string;
  window_hours: number;
  runs: number;
  measured_runs: number;
  active_runs: number;
  total_tokens: number;
  cost_usd: number;
  limit: { reached: boolean; resets_at: string | null; waiting_issues: string[]; message: string | null };
  /** Rate-limit detail a run reported, if any (e.g. five_hour.used_percentage). */
  rate_limit: Record<string, unknown> | null;
}
